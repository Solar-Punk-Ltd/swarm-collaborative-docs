import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'
import {
  MessageData,
  MessageType,
  Options,
  readSingleComment as readDoc,
  writeCommentToIndex as writeDoc,
} from '@solarpunkltd/comment-system'
import { WebrtcProvider } from 'y-webrtc'
import * as Y from 'yjs'

import { DocSettings, NotificationProvider, SignalRecord } from '../interfaces'
import { MIN_TTL_WARN_DAYS, validateStamps } from '../utils/bee'
import { decode, encode, indexStrToBigint, remove0x, retryAwaitableAsync, uuidV4 } from '../utils/common'
import { DOC_FEED_SUFFIX, JOIN_FEED_INDEX, PLACEHOLDER_STAMP } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { EventEmitter } from '../utils/eventEmitter'

import { DOC_EVENTS } from './events'
import { Members } from './members'
import { SwarmSignal } from './signal'

const TAG = 'SwarmDoc'
const DEBOUNCE_MS = 500
const DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS = 5000
const SIGNAL_POLL_INTERVAL_MS = 2000 // faster than member-list poll — drives WebRTC handshake convergence
const OFFER_MAX_AGE_MS = 2 * 60 * 1000 // ignore offers/answers older than 2 minutes (stale session)
const CHANNEL_BINARY_TYPE = 'arraybuffer'

export class SwarmDoc {
  public readonly doc: Y.Doc

  private errorHandler = ErrorHandler.getInstance()
  private emitter: EventEmitter
  private signer: PrivateKey
  private ownAddress: string
  private ownIndex: bigint = -1n
  private docFeedId: string
  private docTopic: string
  private notificationProvider?: NotificationProvider
  private rtcProvider: WebrtcProvider | null = null
  private nickname: string
  private signalingUrl: string | undefined
  private stunUrl: string | undefined
  private iceServers?: RTCIceServer[]
  private beeApiUrl: string
  private regularStamp: string
  private mutableStampId: string
  private members: Members

  private pendingUpdates: Uint8Array[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private publishInFlight = false
  private fetchProcessRunning = false
  private memberListPollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  // Swarm-signaled WebRTC
  private swarmSignal: SwarmSignal | null = null
  private swarmRtcPeers = new Map<string, RTCPeerConnection>() // address → active/pending PC
  private pendingOfferSessions = new Map<string, string>() // peerAddress → sessionId of sent offer
  private sentAnswerKeys = new Set<string>() // `${peerAddress}:${sessionId}` — dedup answered offers
  private ownSessionId: string = ''
  private signalPollTimer: ReturnType<typeof setInterval> | null = null
  private signalCheckInFlight = false

  constructor(settings: DocSettings) {
    this.doc = new Y.Doc()
    this.emitter = new EventEmitter()

    this.signer = new PrivateKey(remove0x(settings.user.privateKey))
    this.ownAddress = this.signer.publicKey().address().toString()
    this.beeApiUrl = settings.infra.beeUrl
    this.regularStamp = settings.infra.stamp || PLACEHOLDER_STAMP
    this.mutableStampId = settings.infra.mutableStamp || PLACEHOLDER_STAMP

    this.docFeedId = settings.infra.topic + DOC_FEED_SUFFIX
    this.docTopic = Topic.fromString(this.docFeedId).toString()

    this.members = new Members(this.docFeedId, this.beeApiUrl, this.mutableStampId)

    const members = (settings.infra.members || [])
      .map(addr => remove0x(addr.toLowerCase()))
      .filter(addr => addr !== this.ownAddress)

    console.log(`${TAG} ownAddress: ${this.ownAddress}`)
    console.log(`${TAG} feedNamespace: ${this.docFeedId}`)
    console.log(`${TAG} topic identifier: ${Topic.fromString(this.docFeedId + this.ownAddress).toString()}`)
    console.log(`${TAG} members configured: ${members.length === 0 ? '(none)' : members.join(', ')}`)
    console.log(`${TAG} mutable stamp: ${this.mutableStampId}`)

    if (settings.infra.stunUrl) {
      this.stunUrl = settings.infra.stunUrl
      console.log(`${TAG} stunUrl: ${this.stunUrl}…`)
    } else {
      this.signalingUrl = settings.infra.signalingUrl
      console.log(`${TAG} signalingUrl: ${this.signalingUrl}…`)
    }

    for (const memberAddress of members) {
      this.registerMember(memberAddress)
    }

    this.nickname = settings.user.nickname
    this.iceServers = settings.infra.iceServers
    this.notificationProvider = settings.notificationProvider
  }

  // Derive comment-system options for own doc feed (stamp only needed for writes)
  private ownFeedOptions(stamp = this.regularStamp): Options {
    return {
      identifier: Topic.fromString(this.docFeedId + this.ownAddress).toString(),
      address: this.ownAddress,
      beeApiUrl: this.beeApiUrl,
      stamp,
      signer: this.signer,
    }
  }

  // Derive comment-system options for reading a peer's doc feed
  private memberFeedOptions(address: string): Options {
    return {
      identifier: Topic.fromString(this.docFeedId + address).toString(),
      address,
      beeApiUrl: this.beeApiUrl,
      stamp: this.regularStamp,
    }
  }

  // Register a peer address so we can read their doc feed. No-op if already registered.
  private registerMember(address: string): void {
    if (!this.members.register(address)) {
      return
    }

    if (!this.rtcProvider) {
      this.notificationProvider?.addMember?.(address)
    }

    this.connectToPeer(address)
    console.log(`${TAG} registerMember: ${address.slice(0, 8)}…`)
  }

  public start(): void {
    if (this.signalingUrl) {
      const room = this.docFeedId

      this.rtcProvider = new WebrtcProvider(room, this.doc, {
        signaling: [this.signalingUrl],
        peerOpts: this.iceServers ? { config: { iceServers: this.iceServers } } : undefined,
      })
      this.rtcProvider.awareness.setLocalStateField('user', {
        address: this.ownAddress,
        nickname: this.nickname,
      })
      this.rtcProvider.awareness.on('change', () => this.onAwarenessChange())
    } else {
      // Swarm-signaled WebRTC — serverless, only active when no y-webrtc signaling server is configured
      this.swarmSignal = new SwarmSignal(this.docFeedId, this.beeApiUrl, this.signer, this.mutableStampId)
      this.swarmSignal.clearOwn() // fire-and-forget: removes stale offers/answers from previous sessions
      this.ownSessionId = uuidV4()
      this.startSignalPoll()
    }

    // Collect incremental Yjs updates; debounce into a single publish.
    // Guard both the legacy 'remote' string origin and y-webrtc provider-instance origin.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.isRemoteOrigin(origin)) return
      this.pendingUpdates.push(update)

      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        const captured = [...this.pendingUpdates]
        this.pendingUpdates = []
        this.debounceTimer = null
        this.publishSnapshot(captured)
      }, DEBOUNCE_MS)
    })

    this.init()

    // Legacy notification polling — only when no y-webrtc provider is configured
    if (!this.rtcProvider) this.startFetchProcess()

    this.startMemberListPoll()
  }

  // y-webrtc sets origin to the provider instance, not the string 'remote'.
  // This guard covers both so Swarm writes are not triggered by remote updates.
  // rtcProvider guard must be null-checked: Yjs uses null as default origin for local transactions,
  // and when there's no signaling URL, rtcProvider is also null — so a bare === would falsely
  // mark every local edit as remote, silently blocking all publishSnapshot calls.
  private isRemoteOrigin(origin: unknown): boolean {
    return origin === 'remote' || origin === 'swarm-rtc' || (this.rtcProvider !== null && origin === this.rtcProvider)
  }

  private onAwarenessChange(): void {
    if (!this.rtcProvider) return

    for (const [clientId, state] of this.rtcProvider.awareness.getStates()) {
      const isSelf = clientId === this.rtcProvider.awareness.clientID
      const userState = (state as { user?: { address?: string } }).user
      const address = userState?.address ? remove0x(userState.address.toLowerCase()) : null

      if (!isSelf && address && address !== this.ownAddress && !this.members.has(address)) {
        this.registerMember(address)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(address)
      }
    }
  }

  public stop(): void {
    this.stopped = true

    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    if (this.memberListPollTimer) {
      clearInterval(this.memberListPollTimer)
      this.memberListPollTimer = null
    }

    if (this.signalPollTimer) {
      clearInterval(this.signalPollTimer)
      this.signalPollTimer = null
    }

    for (const [, pc] of this.swarmRtcPeers) {
      pc.close()
    }

    this.swarmRtcPeers.clear()
    this.rtcProvider?.destroy()
    this.rtcProvider = null
    this.emitter.cleanAll()
    this.notificationProvider?.unsubscribe()
    this.fetchProcessRunning = false
    this.doc.destroy()
  }

  public getEmitter(): EventEmitter {
    return this.emitter
  }

  private applyYjsBytes(b64: string, label: string): void {
    try {
      const bytes = decode(b64)
      console.log(`${TAG} applyYjsBytes [${label}] bytes: ${bytes.length}`)
      Y.applyUpdate(this.doc, bytes, 'remote')
      this.emitter.emit(DOC_EVENTS.DOC_UPDATED, this.doc)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.applyYjsBytes [${label}]`)
    }
  }

  private async publishSnapshot(capturedUpdates: Uint8Array[]): Promise<void> {
    if (this.publishInFlight) {
      this.pendingUpdates.push(...capturedUpdates)

      return
    }

    // Drain the pending queue atomically — snapshot is always full state,
    // so accumulated updates only affect the delta sent to online peers.
    const allUpdates = [...capturedUpdates, ...this.pendingUpdates]
    this.pendingUpdates = []
    this.publishInFlight = true

    try {
      // Full snapshot → written to Swarm with mutable stamp (old chunks get recycled)
      const snapshot = encode(Y.encodeStateAsUpdate(this.doc))

      // Delta → sent in notification payload for peers already online (no Swarm read needed)
      const delta = encode(Y.mergeUpdates(allUpdates))

      const nextIndex = this.ownIndex === -1n ? 0n : this.ownIndex + 1n
      console.log(
        `${TAG} publishSnapshot → index: ${nextIndex}, snapshot: ${(snapshot.length * 0.75) | 0}B, delta: ${(delta.length * 0.75) | 0}B`,
      )

      const messageObj: MessageData = {
        id: uuidV4(),
        username: this.ownAddress,
        address: this.ownAddress,
        topic: this.docTopic,
        signature: '',
        timestamp: Date.now(),
        type: MessageType.TEXT,
        message: snapshot,
        index: FeedIndex.fromBigInt(nextIndex).toString(),
      }

      await writeDoc(messageObj, FeedIndex.fromBigInt(nextIndex), this.ownFeedOptions(this.mutableStampId))
      this.ownIndex = nextIndex
      console.log(`${TAG} publishSnapshot ✓ index: ${this.ownIndex}`)

      // y-webrtc propagates updates automatically via data channels — no manual publish needed
      if (!this.rtcProvider) {
        this.notificationProvider?.publish({
          v: 1,
          topic: this.docTopic,
          author: this.ownAddress,
          feedIndex: Number(nextIndex),
          delta,
        })
      }
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.publishSnapshot`)
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)
    } finally {
      this.publishInFlight = false

      // If more updates arrived while we were publishing, flush them
      if (this.pendingUpdates.length > 0) {
        const next = [...this.pendingUpdates]
        this.pendingUpdates = []
        this.publishSnapshot(next)
      }
    }
  }

  private async init(): Promise<void> {
    console.log(`${TAG} init: starting`)
    try {
      await validateStamps(this.beeApiUrl, this.regularStamp, this.mutableStampId, MIN_TTL_WARN_DAYS, msg => {
        console.warn(`${TAG} ${msg}`)
        this.emitter.emit(DOC_EVENTS.DOC_ERROR, new Error(msg))
      })
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.validateStamps`)
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)

      return
    }
    await Promise.allSettled([this.initOwnIndex(), this.initMemberList()])
    console.log(`${TAG} init: done — ownIndex: ${this.ownIndex}`)

    // No peers at init time — editor is immediately usable, no WebRTC handshake needed
    if (this.members.all().length === 0) {
      this.emitter.emit(DOC_EVENTS.RTC_CONNECTED, true)
    }
  }

  private async initOwnIndex(): Promise<void> {
    console.log(`${TAG} initOwnIndex: reading own feed`)
    const comment = await retryAwaitableAsync(() => readDoc(undefined, this.ownFeedOptions()), 5, 500)

    if (!comment) {
      console.log(`${TAG} initOwnIndex: no previous writes, starting fresh`)

      return
    }

    const parsedIx = indexStrToBigint(comment.index)
    console.log(`${TAG} initOwnIndex: latest index on Swarm = ${parsedIx ?? 'none'}`)

    if (parsedIx !== undefined && !FeedIndex.fromBigInt(parsedIx).equals(FeedIndex.MINUS_ONE)) {
      this.ownIndex = parsedIx
      console.log(`${TAG} initOwnIndex: restoring own snapshot at index ${parsedIx}`)
      this.applyYjsBytes(comment.message, `own idx=${parsedIx}`)
    }
  }

  private async initMemberList(): Promise<void> {
    // Register own address in the consensus memberList, then fetch latest state
    // from every peer listed there (merged with any statically configured members).
    const membersList = await this.members.add(this.ownAddress)
    for (const addr of membersList) {
      if (addr !== this.ownAddress) this.registerMember(addr)
    }

    this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())

    // JOIN_FEED_INDEX sentinel: announce presence via notification feed (legacy transports only)
    // y-webrtc uses awareness.setLocalStateField instead — set in start()
    if (!this.rtcProvider) {
      this.notificationProvider?.publish({
        v: 1,
        topic: this.docTopic,
        author: this.ownAddress,
        feedIndex: JOIN_FEED_INDEX,
      })
      console.log(`${TAG} initMemberList: join notification sent`)
    }

    const members = this.members.all()
    console.log(`${TAG} initMemberList: ${members.length} peer(s) to fetch`)
    await Promise.allSettled(members.map(addr => this.fetchLatestFromMember(addr)))
  }

  // Dispatcher: routes to the fast (delta) or slow (Swarm fetch) path.
  private async fetchLatestFromMember(memberAddress: string, targetIndex?: bigint, delta?: string): Promise<void> {
    if (!this.members.has(memberAddress)) {
      console.log(`${TAG} fetchLatestFromMember: ${memberAddress.slice(0, 8)}… not registered, skipping`)

      return
    }

    if (targetIndex !== undefined && delta !== undefined) {
      this.applyDelta(memberAddress, targetIndex, delta)

      return
    }

    try {
      await this.fetchSnapshot(memberAddress, targetIndex)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.fetchSnapshot(${memberAddress})`)
    }
  }

  // Fast path: notification carries the delta — apply directly, no Swarm read needed.
  private applyDelta(memberAddress: string, targetIndex: bigint, delta: string): void {
    const lastKnown = this.members.lastIndex(memberAddress)

    if (targetIndex <= lastKnown) {
      console.log(`${TAG} applyDelta: ${memberAddress.slice(0, 8)}… idx=${targetIndex} already applied`)

      return
    }

    this.members.setIndex(memberAddress, targetIndex)
    this.applyYjsBytes(delta, `${memberAddress.slice(0, 8)} delta idx=${targetIndex}`)
  }

  // Slow path: read snapshot from Swarm (init phase, or notification had no delta).
  private async fetchSnapshot(memberAddress: string, targetIndex?: bigint): Promise<void> {
    const lastKnown = this.members.lastIndex(memberAddress)
    const options = this.memberFeedOptions(memberAddress)
    let comment: MessageData | undefined
    let targetIx: bigint

    if (targetIndex !== undefined) {
      if (targetIndex <= lastKnown) return

      console.log(`${TAG} fetchSnapshot: ${memberAddress.slice(0, 8)}… waiting for idx=${targetIndex} on Swarm`)
      comment = await retryAwaitableAsync(() => readDoc(FeedIndex.fromBigInt(targetIndex), options), 5, 500)

      if (!comment) {
        console.log(`${TAG} fetchSnapshot: ${memberAddress.slice(0, 8)}… idx=${targetIndex} unavailable after retries`)

        return
      }

      targetIx = targetIndex
    } else {
      comment = await retryAwaitableAsync(() => readDoc(undefined, options), 3, 500)
      const parsedIx = indexStrToBigint(comment?.index)
      console.log(
        `${TAG} fetchSnapshot: ${memberAddress.slice(0, 8)}… latestOnSwarm=${parsedIx ?? 'none'} lastKnown=${lastKnown}`,
      )

      if (!comment || parsedIx === undefined || parsedIx <= lastKnown) return

      targetIx = parsedIx
    }

    this.members.setIndex(memberAddress, targetIx)
    this.applyYjsBytes(comment.message, `${memberAddress.slice(0, 8)} snapshot idx=${targetIx}`)
  }

  public async refreshMemberList(): Promise<void> {
    try {
      const members = await this.members.read()
      console.log(`${TAG} refreshMemberList: got [${members.join(', ')}]`)
      let changed = false
      for (const addr of members) {
        if (addr !== this.ownAddress && !this.members.has(addr)) {
          this.registerMember(addr)
          this.fetchLatestFromMember(addr)
          changed = true
        }
      }

      if (changed) {
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
      } else {
        console.log(`${TAG} refreshMemberList: no new members`)
      }
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.refreshMemberList`)
    }
  }

  private startMemberListPoll(): void {
    this.memberListPollTimer = setInterval(async () => {
      try {
        const members = await this.members.read()
        let changed = false
        for (const addr of members) {
          if (addr !== this.ownAddress && !this.members.has(addr)) {
            this.registerMember(addr)
            this.fetchLatestFromMember(addr)
            changed = true
          }
        }

        if (changed) this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
      } catch {
        // silent — memberList unavailable is not fatal
      }
    }, DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS)
  }

  private startFetchProcess(): void {
    if (this.fetchProcessRunning) return
    this.fetchProcessRunning = true
    console.log(`${TAG} subscribing to topic: ${this.docTopic}`)
    console.log(`${TAG} known members: ${this.members.all().join(', ') || '(none)'}`)
    this.notificationProvider?.subscribe(this.docTopic, payload => {
      const author = remove0x(payload.author.toLowerCase())

      if (author === this.ownAddress) return

      // JOIN_FEED_INDEX: join notification — register peer and fetch their latest snapshot
      if (payload.feedIndex === JOIN_FEED_INDEX) {
        console.log(`${TAG} notification: join from ${author.slice(0, 8)}…`)
        this.registerMember(author)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(author)

        return
      }

      console.log(
        `${TAG} notification: author=${author.slice(0, 8)}…, feedIndex=${payload.feedIndex}, hasDelta=${Boolean(payload.delta)}`,
      )
      this.fetchLatestFromMember(author, BigInt(payload.feedIndex), payload.delta)
    })
  }

  // ── Swarm-signaled WebRTC ─────────────────────────────────────────────────

  /** Decides whether to initiate a WebRTC connection to a newly discovered peer. */
  private connectToPeer(address: string): void {
    if (!this.swarmSignal) {
      console.log(`${TAG} swarm-rtc: connectToPeer ${address.slice(0, 8)}… skipped — swarmSignal not ready`)

      return
    }

    if (this.swarmRtcPeers.has(address)) {
      console.log(`${TAG} swarm-rtc: connectToPeer ${address.slice(0, 8)}… skipped — already connected`)

      return
    }

    const role = this.isInitiatorFor(address) ? 'initiator' : 'answerer'
    console.log(`${TAG} swarm-rtc: connectToPeer ${address.slice(0, 8)}… role=${role}`)

    if (this.isInitiatorFor(address)) {
      this.initiateConnectionTo(address)
    }
    // Answerers wait — startSignalPoll() will pick up the initiator's offer
  }

  /** Deterministic role: lower address is always the initiator. Prevents duplicate connections. */
  private isInitiatorFor(peerAddress: string): boolean {
    return this.ownAddress < peerAddress
  }

  // TODO: iceServers url is hard coded, pass it from the UI
  /** Creates an RTCPeerConnection as the initiator, gathers ICE, publishes offer to signal feed. */
  private async initiateConnectionTo(peerAddress: string): Promise<void> {
    if (!this.swarmSignal || this.swarmRtcPeers.has(peerAddress)) return

    if (!this.stunUrl) {
      console.warn(`${TAG} swarm-rtc: initiateConnectionTo no stunUrl is provided`)

      return
    }

    console.log(`${TAG} swarm-rtc: initiating → ${peerAddress.slice(0, 8)}…`)

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length ? this.iceServers : [{ urls: this.stunUrl }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      console.log(`${TAG} swarm-rtc: [initiator→${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.swarmRtcPeers.delete(peerAddress)
        this.pendingOfferSessions.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(
        `${TAG} swarm-rtc: [initiator→${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`,
      )
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      console.warn(
        `${TAG} swarm-rtc: [initiator→${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    const dc = pc.createDataChannel('yjs')

    dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
    dc.addEventListener('error', e => console.error(`${TAG} swarm-rtc: [initiator] dataChannel error`, e))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    console.log(`${TAG} swarm-rtc: ICE gathering started for ${peerAddress.slice(0, 8)}…`)
    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    console.log(
      `${TAG} swarm-rtc: ICE gathered for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`,
    )

    if (this.stopped) {
      // StrictMode: this instance was torn down while gathering ICE; discard offer
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} swarm-rtc: initiateConnectionTo ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

      return
    }

    console.log(`${TAG} swarm-rtc: initiateConnectionTo ${peerAddress.slice(0, 8)}… instance live, writing offer`)
    const sessionId = uuidV4()
    this.pendingOfferSessions.set(peerAddress, sessionId)

    const record: SignalRecord = {
      type: 'offer',
      fromAddress: this.ownAddress,
      toAddress: peerAddress,
      sessionId,
      timestamp: Date.now(),
      sdp,
    }

    await this.swarmSignal.writeRecord(record)
    console.log(`${TAG} swarm-rtc: offer written → ${peerAddress.slice(0, 8)}… sessionId=${sessionId.slice(0, 8)}`)
  }

  /** Receives a peer's offer, creates an answer, publishes it to own signal feed. */
  private async answerPeerOffer(peerAddress: string, offer: SignalRecord): Promise<void> {
    if (!this.swarmSignal || this.swarmRtcPeers.has(peerAddress)) return

    if (!this.stunUrl) {
      console.warn(`${TAG} swarm-rtc: initiateConnectionTo no stunUrl is provided`)

      return
    }

    const key = `${peerAddress}:${offer.sessionId}`

    if (this.sentAnswerKeys.has(key)) return

    console.log(
      `${TAG} swarm-rtc: answering offer from ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`,
    )
    this.sentAnswerKeys.add(key)

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length ? this.iceServers : [{ urls: this.stunUrl }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      console.log(`${TAG} swarm-rtc: [answerer←${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.swarmRtcPeers.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`${TAG} swarm-rtc: [answerer←${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`)
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      console.warn(
        `${TAG} swarm-rtc: [answerer←${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      console.log(`${TAG} swarm-rtc: datachannel received from ${peerAddress.slice(0, 8)}…`)
      const dc = event.channel
      dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
      dc.addEventListener('error', e => console.error(`${TAG} swarm-rtc: [answerer] dataChannel error`, e))
    })

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    console.log(`${TAG} swarm-rtc: ICE gathering started (answerer) for ${peerAddress.slice(0, 8)}…`)
    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    console.log(
      `${TAG} swarm-rtc: ICE gathered (answerer) for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`,
    )

    if (this.stopped) {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} swarm-rtc: answerPeerOffer ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

      return
    }

    const record: SignalRecord = {
      type: 'answer',
      fromAddress: this.ownAddress,
      toAddress: peerAddress,
      sessionId: offer.sessionId,
      timestamp: Date.now(),
      sdp,
    }

    await this.swarmSignal.writeRecord(record)
    console.log(
      `${TAG} swarm-rtc: answer written → ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`,
    )
  }

  /** Polls each known peer's signal feed for offers (to answer) and answers (to finalise). */
  private startSignalPoll(): void {
    console.log(`${TAG} swarm-rtc: signal poll started (interval=${SIGNAL_POLL_INTERVAL_MS}ms)`)
    this.checkSignals()
    this.signalPollTimer = setInterval(() => this.checkSignals(), SIGNAL_POLL_INTERVAL_MS)
  }

  private async checkSignals(): Promise<void> {
    if (!this.swarmSignal || this.signalCheckInFlight) return
    this.signalCheckInFlight = true

    const peers = this.members.all()

    if (peers.length === 0) {
      this.signalCheckInFlight = false

      return
    }

    console.log(
      `${TAG} swarm-rtc: checking signals for ${peers.length} peer(s): ${peers.map(a => a.slice(0, 8)).join(', ')}`,
    )

    try {
      await Promise.allSettled(peers.map(addr => this.checkPeerSignals(addr)))
    } finally {
      this.signalCheckInFlight = false
    }
  }

  private async checkPeerSignals(peerAddress: string): Promise<void> {
    if (peerAddress === this.ownAddress || !this.swarmSignal) return

    const payload = await this.swarmSignal.read(peerAddress)

    if (!payload) {
      console.log(`${TAG} swarm-rtc: no new signal from ${peerAddress.slice(0, 8)}…`)

      return
    }

    console.log(`${TAG} swarm-rtc: signal feed for ${peerAddress.slice(0, 8)}… has ${payload.records.length} record(s)`)

    for (const record of payload.records) {
      const recordAgeS = Math.round((Date.now() - record.timestamp) / 1000)
      console.log(
        `${TAG} swarm-rtc:   record type=${record.type} to=${record.toAddress.slice(0, 8)} sessionId=${record.sessionId.slice(0, 8)} age=${recordAgeS}s`,
      )

      if (record.type === 'offer' && record.toAddress === this.ownAddress) {
        const ageMs = Date.now() - record.timestamp

        if (ageMs > OFFER_MAX_AGE_MS) {
          console.log(
            `${TAG} swarm-rtc: skipping stale offer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`,
          )
        } else {
          const key = `${peerAddress}:${record.sessionId}`

          if (this.swarmRtcPeers.has(peerAddress)) {
            console.log(`${TAG} swarm-rtc: offer from ${peerAddress.slice(0, 8)}… skipped — already have PC`)
          } else if (this.sentAnswerKeys.has(key)) {
            console.log(`${TAG} swarm-rtc: offer from ${peerAddress.slice(0, 8)}… skipped — already answered`)
          } else {
            await this.answerPeerOffer(peerAddress, record)
          }
        }
      }

      if (record.type === 'answer' && record.toAddress === this.ownAddress) {
        const ageMs = Date.now() - record.timestamp

        if (ageMs > OFFER_MAX_AGE_MS) {
          console.log(
            `${TAG} swarm-rtc: skipping stale answer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`,
          )
        } else {
          const pc = this.swarmRtcPeers.get(peerAddress)
          const expectedSession = this.pendingOfferSessions.get(peerAddress)

          console.log(
            `${TAG} swarm-rtc: answer from ${peerAddress.slice(0, 8)}… expectedSession=${expectedSession?.slice(0, 8) ?? 'none'} recordSession=${record.sessionId.slice(0, 8)} hasPC=${Boolean(pc)} alreadyAnswered=${Boolean(pc?.currentRemoteDescription)}`,
          )

          if (pc && pc.signalingState === 'have-local-offer' && record.sessionId === expectedSession) {
            try {
              await pc.setRemoteDescription({ type: 'answer', sdp: record.sdp })
              this.pendingOfferSessions.delete(peerAddress)
              console.log(`${TAG} swarm-rtc: handshake complete with ${peerAddress.slice(0, 8)}…`)
              console.log(
                `${TAG} swarm-rtc: post-handshake state — connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState} signalingState=${pc.signalingState}`,
              )

              // Poll PC state for 10s so we can see ICE progress without relying solely on events
              let polls = 0
              const poller = setInterval(() => {
                console.log(
                  `${TAG} swarm-rtc: [poll ${++polls}] connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState}`,
                )

                if (polls >= 10 || pc.connectionState === 'connected' || pc.connectionState === 'failed') {
                  clearInterval(poller)
                }
              }, 1000)
            } catch (err) {
              this.errorHandler.handleError(err, `${TAG}.setRemoteDescription`)
            }
          }
        }
      }
    }
  }

  /** Sets up Yjs sync over an open WebRTC data channel. */
  private setupDataChannel(peerAddress: string, channel: RTCDataChannel): void {
    console.log(`${TAG} swarm-rtc: channel OPEN with ${peerAddress.slice(0, 8)}…`)
    this.emitter.emit(DOC_EVENTS.RTC_CONNECTED, true)

    // Must be set before any messages arrive; default 'blob' causes Uint8Array construction to fail.
    channel.binaryType = CHANNEL_BINARY_TYPE

    const initialState = Y.encodeStateAsUpdate(this.doc)
    console.log(`${TAG} swarm-rtc: sending initial state to ${peerAddress.slice(0, 8)}… bytes=${initialState.length}`)
    channel.send(initialState as unknown as Uint8Array<ArrayBuffer>)

    channel.addEventListener('message', (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      console.log(`${TAG} swarm-rtc: received ${data.length}B from ${peerAddress.slice(0, 8)}…`)
      Y.applyUpdate(this.doc, data, 'swarm-rtc')
      this.emitter.emit(DOC_EVENTS.DOC_UPDATED, this.doc)
    })

    const forwardUpdate = (update: Uint8Array, origin: unknown) => {
      if (!this.isRemoteOrigin(origin) && channel.readyState === 'open') {
        console.log(`${TAG} swarm-rtc: forwarding update ${update.length}B → ${peerAddress.slice(0, 8)}…`)
        channel.send(update as unknown as Uint8Array<ArrayBuffer>)
      }
    }

    this.doc.on('update', forwardUpdate)

    channel.addEventListener('close', () => {
      this.doc.off('update', forwardUpdate)
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} swarm-rtc: channel CLOSED with ${peerAddress.slice(0, 8)}…`)
    })
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') {
        console.log(`${TAG} swarm-rtc: ICE already complete`)
        resolve()

        return
      }

      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          console.log(`${TAG} swarm-rtc: ICE gathering complete (event)`)
          resolve()
        }
      }

      pc.addEventListener('icegatheringstatechange', onStateChange)
      setTimeout(() => {
        console.log(`${TAG} swarm-rtc: ICE gathering timed out after ${timeoutMs}ms, state=${pc.iceGatheringState}`)
        resolve()
      }, timeoutMs)
    })
  }
}
