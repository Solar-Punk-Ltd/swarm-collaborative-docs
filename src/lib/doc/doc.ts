import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'
import {
  MessageData,
  MessageType,
  Options,
  readSingleComment as readDoc,
  writeCommentToIndex as writeDoc,
} from '@solarpunkltd/comment-system'
import * as Y from 'yjs'

import { DocSettings, DocTransport } from '../interfaces'
import { MIN_TTL_WARN_DAYS, validateStamps } from '../utils/bee'
import { decode, encode, indexStrToBigint, remove0x, retryAwaitableAsync, uuidV4 } from '../utils/common'
import { DOC_FEED_SUFFIX, JOIN_FEED_INDEX, PLACEHOLDER_STAMP } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { EventEmitter } from '../utils/eventEmitter'

import { DOC_EVENTS } from './events'
import { Members } from './members'

const TAG = 'SwarmDoc'
const DEBOUNCE_MS = 500
const DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS = 5000

export class SwarmDoc {
  public readonly doc: Y.Doc

  private errorHandler = ErrorHandler.getInstance()
  private emitter: EventEmitter
  private signer: PrivateKey
  private ownAddress: string
  private ownIndex: bigint = -1n
  private docFeedId: string
  private docTopic: string
  private transport: DocTransport
  private beeApiUrl: string
  private regularStamp: string
  private mutableStampId: string
  private members: Members

  private pendingUpdates: Uint8Array[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private publishInFlight = false
  private fetchProcessRunning = false
  private memberListPollTimer: ReturnType<typeof setInterval> | null = null

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

    this.transport = settings.infra.transport({
      doc: this.doc,
      emitter: this.emitter,
      members: this.members,
      ownAddress: this.ownAddress,
      nickname: settings.user.nickname,
      onPeerDiscovered: (address: string) => {
        this.registerMember(address)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(address)
      },
      docFeedId: this.docFeedId,
      beeApiUrl: this.beeApiUrl,
      signer: this.signer,
      mutableStampId: this.mutableStampId,
    })

    for (const memberAddress of members) {
      this.registerMember(memberAddress)
    }
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

    this.transport.connectToPeer(address)
    console.log(`${TAG} registerMember: ${address.slice(0, 8)}…`)
  }

  public start(): void {
    this.transport.start()

    // Collect incremental Yjs updates; debounce into a single publish.
    // Guard both the legacy 'remote' string origin and transport-specific origins.
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
    this.startFetchProcess()
    this.startMemberListPoll()
  }

  // Returns true for any origin that should not trigger a Swarm publish or RTC forward.
  private isRemoteOrigin(origin: unknown): boolean {
    return origin === 'remote' || (this.transport.isRemoteOrigin(origin) ?? false)
  }

  public stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    if (this.memberListPollTimer) {
      clearInterval(this.memberListPollTimer)
      this.memberListPollTimer = null
    }

    this.transport.stop()
    this.emitter.cleanAll()
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

      this.transport.publish({
        v: 1,
        topic: this.docTopic,
        author: this.ownAddress,
        feedIndex: Number(nextIndex),
        delta,
      })
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

    // JOIN_FEED_INDEX sentinel: announce presence via transport
    this.transport.publish({
      v: 1,
      topic: this.docTopic,
      author: this.ownAddress,
      feedIndex: JOIN_FEED_INDEX,
    })
    console.log(`${TAG} initMemberList: join notification sent`)

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
    this.transport.subscribe(this.docTopic, payload => {
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
}
