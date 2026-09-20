import { FeedIndex, PrivateKey, Signature, Topic } from '@ethersphere/bee-js'
import * as Y from 'yjs'

import {
  CursorPosition,
  DocSettings,
  DocTransport,
  IDocFeed,
  IMembers,
  ISwarmDoc,
  MemberEntry,
  NotificationHandler,
  NotificationPayload,
  PeerConnectionState,
} from '../interfaces'
import { deriveSessionSigner, validateStamps } from '../utils/bee'
import { decode, encode, Origin, remove0x, uuidV4 } from '../utils/common'
import { API_VERSION, DOC_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { EventEmitter } from '../utils/eventEmitter'
import { Logger } from '../utils/logger'
import { Room } from '../utils/room'

import { DocFeed } from './docFeed'
import { DOC_EVENTS } from './events'
import { Members } from './members'

const TAG = 'SwarmDoc'
const DEBOUNCE_MS = 500
const DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS = 5000
const DISCONNECTED_MEMBER_POLL_INTERVAL_MS = 15000
const MIN_TTL_WARN_DAYS = 2
/*
 * How long the document waits for peers that were present at startup but whose state has not
 * arrived. A peer that is simply gone would otherwise hold the document shut forever, so the wait
 * has to end; ending it too early is what hands the author a fragment to edit.
 *
 * Sized against the retries that can still rescue it rather than against a feel: the disconnected
 * poll runs every 15 s and a data channel opening triggers a fetch of its own, so this covers two
 * poll passes and most handshakes. A feed poisoned by a failed read stays unreadable for about a
 * minute, and waiting that long before allowing a keystroke is worse than opening incomplete —
 * which is why the count of peers still owing state stays visible afterwards.
 */
const SYNC_GRACE_MS = 30000

export class SwarmDoc implements ISwarmDoc {
  public readonly doc: Y.Doc
  private errorHandler = ErrorHandler.getInstance()
  private emitter: EventEmitter
  private identitySigner: PrivateKey
  private identityAddress: string
  private signer: PrivateKey
  private ownAddress: string
  private sessionId: string
  private username: string
  private ownIndex: bigint = -1n
  private ownIndexResolved = false
  private room: Room
  private docFeedId: string
  private docTopic: string
  private transport: DocTransport
  private beeApiUrl: string
  private stampId: string
  private members: IMembers
  private docFeed: IDocFeed

  private pendingUpdates: Uint8Array[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private publishQueue: Promise<void> = Promise.resolve()
  private nameHints: Map<string, string>
  private fetchProcessRunning = false
  private memberListPollTimer: ReturnType<typeof setInterval> | null = null
  private disconnectedPollTimer: ReturnType<typeof setInterval> | null = null
  private localCursor: CursorPosition = null
  private cursorTimer: ReturnType<typeof setInterval> | null = null
  private connectedPeers = new Set<string>()
  /** Peers present at startup whose state has not been applied yet. */
  private pendingSync = new Set<string>()
  private synced = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly logger = Logger.getInstance()

  constructor(settings: DocSettings) {
    this.doc = new Y.Doc()
    this.emitter = new EventEmitter()

    this.sessionId = settings.user.sessionId ?? uuidV4()
    this.identitySigner = new PrivateKey(remove0x(settings.user.privateKey))
    this.identityAddress = this.identitySigner.publicKey().address().toString()
    this.signer = deriveSessionSigner(settings.user.privateKey, this.sessionId)
    this.ownAddress = this.signer.publicKey().address().toString()
    this.username = settings.user.nickname
    this.beeApiUrl = settings.infra.beeUrl
    this.stampId = settings.infra.stamp

    this.room = new Room(settings.infra.roomKey, settings.infra.roomCreator)

    this.docFeedId = this.room.namespace + DOC_FEED_SUFFIX
    this.docTopic = Topic.fromString(this.docFeedId).toString()

    this.members = new Members(this.room, this.identityAddress, this.beeApiUrl, this.stampId)
    this.docFeed = new DocFeed(this.beeApiUrl, this.stampId)

    this.nameHints = new Map(
      Array.from(settings.infra.members ?? [], ([addr, username]) => [remove0x(addr.toLowerCase()), username]),
    )

    this.transport = settings.infra.transport({
      doc: this.doc,
      emitter: this.emitter,
      members: this.members,
      ownAddress: this.ownAddress,
      ownIdentity: this.identityAddress,
      sessionId: this.sessionId,
      nickname: settings.user.nickname,
      onPeerDiscovered: (address: string, entry: MemberEntry) => {
        this.registerMember(address, entry)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(address)
      },
      docFeedId: this.docFeedId,
      beeApiUrl: this.beeApiUrl,
      signer: this.signer,
      stampId: this.stampId,
    })
  }

  private ownFeedTopic(): Topic {
    return Topic.fromString(this.docFeedId + this.ownAddress)
  }

  private memberFeedTopic(address: string): Topic {
    return Topic.fromString(this.docFeedId + address)
  }

  private registerMember(address: string, entry: MemberEntry): void {
    const named = { ...entry, username: entry.username || this.nameHints.get(entry.identity) || entry.username }
    const isNew = this.members.register(address, named)

    // A peer that has shut down will never deliver, so it must not hold the document shut either.
    if (!named.live) {
      this.resolvePendingSync(address)
    }

    // Dialled regardless of `live`: the flag is last-write-wins shared state, and a stale retire
    // (a reload reuses the session id, so its retire can land after the new instance's add) would
    // otherwise strand the peer for good. Transports ignore a peer that already has a connection.
    this.transport.connectToPeer(address)

    if (isNew) {
      this.logger.debug(`${TAG} registerMember: ${address.slice(0, 8)}… live=${named.live}`)
    }
  }

  public start(): void {
    this.transport.start()

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.isRemoteOrigin(origin)) {
        return
      }

      this.pendingUpdates.push(update)
      this.emitter.emit(DOC_EVENTS.WRITE_PENDING, true)

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
      }

      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        this.drainPendingUpdates()
      }, DEBOUNCE_MS)
    })

    this.watchPeerStates()
    this.init()
    this.startFetchProcess()
    this.startMemberListPoll()
    this.startDisconnectedMemberPoll()
    this.startCursorBroadcast()
  }

  public updateCursor(cursor: CursorPosition): void {
    this.localCursor = cursor
  }

  public async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.drainPendingUpdates()

    await this.publishQueue
  }

  private isRemoteOrigin(origin: unknown): boolean {
    return origin === Origin.Remote || (this.transport.isRemoteOrigin(origin) ?? false)
  }

  public stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }

    for (const timer of [this.memberListPollTimer, this.disconnectedPollTimer, this.cursorTimer]) {
      if (timer) clearInterval(timer)
    }
    this.memberListPollTimer = null
    this.disconnectedPollTimer = null
    this.cursorTimer = null

    this.transport.publish({
      type: 'leave',
      v: API_VERSION,
      topic: this.docTopic,
      author: this.ownAddress,
      identity: this.identityAddress,
      username: this.username,
    })
    this.members.retire(this.ownAddress).catch(() => {
      // best effort — the session is going away regardless
    })

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
      Y.applyUpdate(this.doc, bytes, Origin.Remote)
      this.emitter.emit(DOC_EVENTS.DOC_UPDATED, this.doc)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.applyYjsBytes [${label}]`)
    }
  }

  private drainPendingUpdates(): void {
    if (this.pendingUpdates.length === 0) {
      return
    }

    const captured = [...this.pendingUpdates]
    this.pendingUpdates = []

    // Serialised so each write lands on a distinct, increasing feed index.
    this.publishQueue = this.publishQueue.then(() => this.publishSnapshot(captured))
  }

  private async publishSnapshot(capturedUpdates: Uint8Array[]): Promise<void> {
    try {
      // Retried here rather than only at init, so a node that was unreachable at startup does not
      // leave the session unable to publish for the rest of its life.
      await this.ensureOwnIndex()

      const snapshot = encode(Y.encodeStateAsUpdate(this.doc))
      const delta = encode(Y.mergeUpdates(capturedUpdates))

      const nextIndex = this.ownIndex + 1n
      this.logger.debug(
        `${TAG} publishSnapshot → index: ${nextIndex}, snapshot: ${(snapshot.length * 0.75) | 0}B, delta: ${(delta.length * 0.75) | 0}B`,
      )

      // Claim the index before the write and keep it claimed if the write throws: a failed upload
      // may still have stored its chunk, and reusing the index would put a second one at that address.
      this.ownIndex = nextIndex
      await this.docFeed.write(this.ownFeedTopic(), this.signer, FeedIndex.fromBigInt(nextIndex), snapshot)

      const deltaBytes = decode(delta)
      const sig = this.signer.sign(deltaBytes).toHex()

      this.transport.publish({
        type: 'doc',
        v: API_VERSION,
        topic: this.docTopic,
        author: this.ownAddress,
        identity: this.identityAddress,
        username: this.username,
        feedIndex: Number(nextIndex),
        delta,
        sig,
      })
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.publishSnapshot`)
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)
    } finally {
      if (this.pendingUpdates.length === 0 && !this.debounceTimer) {
        this.emitter.emit(DOC_EVENTS.WRITE_DONE, true)
      }
    }
  }

  private async init(): Promise<void> {
    try {
      await validateStamps(this.beeApiUrl, this.stampId, MIN_TTL_WARN_DAYS, msg => {
        this.logger.warn(`${TAG} ${msg}`)
        this.emitter.emit(DOC_EVENTS.DOC_ERROR, new Error(msg))
      })
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.validateStamps`)
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)

      return
    }
    const [ownIndex] = await Promise.allSettled([this.initOwnIndex(), this.initMemberList()])

    // Reported rather than swallowed: the document still opens and receives, but nothing it writes
    // reaches Swarm until the feed position resolves, and a silent read-only session looks like sync.
    if (ownIndex.status === 'rejected') {
      this.errorHandler.handleError(ownIndex.reason, `${TAG}.initOwnIndex`)
      this.emitter.emit(
        DOC_EVENTS.DOC_ERROR,
        new Error('Could not read this session’s feed position — edits are not being saved to Swarm yet.'),
      )
    }

    this.logger.debug(`${TAG} init: done — ownIndex: ${this.ownIndex}`)

    this.emitter.emit(DOC_EVENTS.DOC_READY, { memberCount: this.members.all().size })
    this.startSyncWatch()
  }

  /*
   * A peer discovered at startup whose snapshot did not read yet still owes us part of the
   * document. Editing before it arrives means typing into a fragment and merging the result into a
   * version the author never saw, which is how a document silently loses content.
   */
  private startSyncWatch(): void {
    for (const [address, entry] of this.members.all()) {
      if (address !== this.ownAddress && entry.live && this.members.lastIndex(address) < 0n) {
        this.pendingSync.add(address)
      }
    }

    if (this.pendingSync.size === 0) {
      this.markSynced()

      return
    }

    this.logger.debug(`${TAG} document incomplete — waiting on ${this.pendingSync.size} peer(s)`)
    this.emitSyncState()

    this.syncTimer = setTimeout(() => {
      this.logger.warn(
        `${TAG} ${this.pendingSync.size} peer(s) delivered no state in ${SYNC_GRACE_MS}ms — opening the document anyway`,
      )
      this.markSynced()
    }, SYNC_GRACE_MS)
  }

  /** Records that a peer no longer owes state, because it delivered some or is no longer live. */
  private resolvePendingSync(address: string): void {
    if (!this.pendingSync.delete(address)) {
      return
    }

    if (this.pendingSync.size === 0) {
      this.markSynced()
    } else {
      this.emitSyncState()
    }
  }

  // Latched: a peer that joins later must not disable an editor somebody is already typing in.
  private markSynced(): void {
    if (this.synced) {
      return
    }

    this.synced = true

    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }

    this.emitSyncState()
  }

  private emitSyncState(): void {
    this.emitter.emit(DOC_EVENTS.DOC_SYNC_STATE, { synced: this.synced, pending: this.pendingSync.size })
  }

  /*
   * The tail is probed rather than drained: a session may be re-created against a feed it already
   * wrote, and resolving the tail short would republish over an existing index, leaving two
   * payloads at one chunk address that the node can no longer serve. A tail that cannot be
   * determined blocks publishing instead of defaulting to 0 — guessing here is what corrupts a feed.
   */
  private async ensureOwnIndex(): Promise<void> {
    if (this.ownIndexResolved) {
      return
    }

    this.ownIndex = await this.docFeed.resolveTail(this.ownFeedTopic(), this.ownAddress)
    this.ownIndexResolved = true
    this.logger.debug(`${TAG} own feed tail resolved at index ${this.ownIndex}`)
  }

  private async initOwnIndex(): Promise<void> {
    await this.ensureOwnIndex()

    if (this.ownIndex < 0n) {
      return
    }

    const entry = await this.docFeed.read(this.ownFeedTopic(), this.ownAddress, FeedIndex.fromBigInt(this.ownIndex))

    if (entry) {
      this.applyYjsBytes(entry.snapshot, `own idx=${this.ownIndex}`)
    }
  }

  private async initMemberList(): Promise<void> {
    await this.members.add(this.ownAddress, this.ownEntry())

    // Read straight after announcing rather than waiting for the first poll: discovery is what
    // gates the whole handshake, and a peer found five seconds later is five seconds of latency.
    const membersList = (await this.members.read()) ?? new Map()

    for (const [addr, entry] of membersList) {
      if (addr !== this.ownAddress) {
        this.registerMember(addr, entry)
      }
    }

    this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())

    this.transport.publish({
      type: 'join',
      v: API_VERSION,
      topic: this.docTopic,
      author: this.ownAddress,
      identity: this.identityAddress,
      username: this.username,
    })

    const members = this.members.all()
    this.logger.debug(`${TAG} initMemberList: ${members.size} peer(s) to fetch`)
    const memberPromises: Promise<void>[] = []
    members.forEach((_entry: MemberEntry, addr: string) => memberPromises.push(this.fetchLatestFromMember(addr)))
    await Promise.allSettled(memberPromises)
  }

  private ownEntry(): MemberEntry {
    return {
      username: this.username,
      identity: this.identityAddress,
      sessionId: this.sessionId,
      lastSeen: Date.now(),
      live: true,
    }
  }

  private async fetchLatestFromMember(memberAddress: string, targetIndex?: bigint, delta?: string): Promise<void> {
    if (!this.members.has(memberAddress)) {
      this.logger.debug(`${TAG} fetchLatestFromMember: ${memberAddress.slice(0, 8)}… not registered, skipping`)

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

  private applyDelta(memberAddress: string, targetIndex: bigint, delta: string): void {
    const lastKnown = this.members.lastIndex(memberAddress)

    if (targetIndex <= lastKnown) {
      this.logger.debug(`${TAG} applyDelta: ${memberAddress.slice(0, 8)}… idx=${targetIndex} already applied`)

      return
    }

    // A gap means we never saw the updates in between; Yjs would park this delta as pending,
    // so take the peer's full snapshot instead.
    if (targetIndex > lastKnown + 1n) {
      this.logger.debug(
        `${TAG} applyDelta: ${memberAddress.slice(0, 8)}… gap lastKnown=${lastKnown} target=${targetIndex}, fetching snapshot`,
      )
      this.fetchLatestFromMember(memberAddress, targetIndex)

      return
    }

    this.members.setIndex(memberAddress, targetIndex)
    this.applyYjsBytes(delta, `${memberAddress.slice(0, 8)} delta idx=${targetIndex}`)
    this.resolvePendingSync(memberAddress)
  }

  private async fetchSnapshot(memberAddress: string, targetIndex?: bigint): Promise<void> {
    const lastKnown = this.members.lastIndex(memberAddress)

    if (targetIndex !== undefined && targetIndex <= lastKnown) {
      return
    }

    const topic = this.memberFeedTopic(memberAddress)
    const entry =
      targetIndex === undefined
        ? await this.docFeed.readLatestFrom(topic, memberAddress, lastKnown + 1n)
        : await this.docFeed.read(topic, memberAddress, FeedIndex.fromBigInt(targetIndex))

    if (!entry) {
      this.logger.debug(`${TAG} fetchSnapshot: ${memberAddress.slice(0, 8)}… nothing readable`)

      return
    }

    const targetIx = targetIndex ?? entry.index

    if (targetIx <= lastKnown) return

    this.members.setIndex(memberAddress, targetIx)
    this.applyYjsBytes(entry.snapshot, `${memberAddress.slice(0, 8)} snapshot idx=${targetIx}`)
    this.resolvePendingSync(memberAddress)
  }

  public async refreshMemberList(): Promise<void> {
    try {
      await this.mergeRemoteMemberList()
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.refreshMemberList`)
    }
  }

  private async mergeRemoteMemberList(): Promise<void> {
    const members = await this.members.read()

    if (!members || members.size === 0) {
      return
    }

    let changed = false
    for (const [addr, entry] of members) {
      if (addr !== this.ownAddress) {
        const known = this.members.get(addr)

        if (!known) {
          this.registerMember(addr, entry)
          this.fetchLatestFromMember(addr)
          changed = true
        } else if (known.live !== entry.live) {
          this.registerMember(addr, entry)
          changed = true
        }
      }
    }

    if (changed) {
      this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
    }
  }

  private startMemberListPoll(): void {
    this.memberListPollTimer = setInterval(() => {
      this.mergeRemoteMemberList().catch(() => {
        // transient read failures are expected; the next tick retries
      })
    }, DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS)
  }

  /**
   * A peer's snapshot feed is otherwise read once, when it is first seen. Until a data channel
   * is up — which can take tens of seconds over Swarm signalling, or never — anything the peer
   * writes after that would be missed entirely.
   */
  private startDisconnectedMemberPoll(): void {
    this.disconnectedPollTimer = setInterval(() => {
      const states = this.members.allConnectionStates()

      for (const [addr] of this.members.all()) {
        if (addr !== this.ownAddress && states.get(addr) !== PeerConnectionState.Connected) {
          this.fetchLatestFromMember(addr)
        }
      }
    }, DISCONNECTED_MEMBER_POLL_INTERVAL_MS)
  }

  // A channel opening means the peer was unreachable until now — close the gap from their feed
  // before relying on the channel, since deltas alone cannot fill it.
  private watchPeerStates(): void {
    this.emitter.on(DOC_EVENTS.PEER_STATE_UPDATED, (states: ReadonlyMap<string, PeerConnectionState>) => {
      for (const [addr, state] of states) {
        if (state === PeerConnectionState.Connected) {
          if (!this.connectedPeers.has(addr)) {
            this.connectedPeers.add(addr)
            this.fetchLatestFromMember(addr)
          }
        } else {
          this.connectedPeers.delete(addr)
        }
      }
    })
  }

  private startFetchProcess(): void {
    if (this.fetchProcessRunning) return

    this.fetchProcessRunning = true

    this.logger.log(`${TAG} subscribing to topic: ${this.docTopic}`)

    const handler: NotificationHandler = (payload: NotificationPayload): void => {
      const author = remove0x(payload.author.toLowerCase())

      if (author === this.ownAddress) return

      if (payload.type === 'join') {
        this.logger.debug(`${TAG} notification: join from ${author.slice(0, 8)}…`)
        this.registerMember(author, this.entryFromPayload(payload))
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(author)

        return
      }

      if (payload.type === 'leave') {
        this.logger.debug(`${TAG} notification: leave from ${author.slice(0, 8)}…`)
        const known = this.members.get(author)

        if (known) {
          this.members.register(author, { ...known, live: false })
          this.resolvePendingSync(author)
          this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        }

        return
      }

      if (payload.type === 'cursor') {
        this.emitter.emit(DOC_EVENTS.AWARENESS_UPDATED, {
          address: author,
          identity: remove0x(payload.identity.toLowerCase()),
          username: payload.username,
          cursor: payload.cursor,
        })

        return
      }

      if (payload.type !== 'doc') {
        this.logger.warn(`${TAG} unknown payload type from ${author.slice(0, 8)}…`)

        return
      }

      if (!payload.delta) {
        this.logger.warn(`${TAG} dropping message from ${author.slice(0, 8)}…, no delta provided`)

        return
      }

      if (!payload.sig) {
        this.logger.warn(`${TAG} dropping unsigned delta from ${author.slice(0, 8)}…`)

        return
      }

      try {
        const valid = new Signature(payload.sig).isValid(decode(payload.delta), author)

        if (!valid) {
          this.logger.warn(`${TAG} dropping delta with invalid signature from ${author.slice(0, 8)}…`)

          return
        }
      } catch {
        this.logger.warn(`${TAG} signature verification error from ${author.slice(0, 8)}… — dropping`)

        return
      }

      this.logger.debug(
        `${TAG} notification: author=${author.slice(0, 8)}…, feedIndex=${payload.feedIndex}, hasDelta=${Boolean(payload.delta)}`,
      )
      this.fetchLatestFromMember(author, BigInt(payload.feedIndex), payload.delta)
    }

    this.transport.subscribe(this.docTopic, handler)
  }

  private entryFromPayload(payload: NotificationPayload): MemberEntry {
    return {
      username: payload.username,
      identity: remove0x(payload.identity.toLowerCase()),
      sessionId: '',
      lastSeen: Date.now(),
      live: true,
    }
  }

  private startCursorBroadcast(): void {
    this.cursorTimer = setInterval(() => {
      this.transport.publish({
        type: 'cursor',
        v: API_VERSION,
        topic: this.docTopic,
        author: this.ownAddress,
        identity: this.identityAddress,
        username: this.username,
        cursor: this.localCursor,
      })
    }, DEBOUNCE_MS)
  }
}
