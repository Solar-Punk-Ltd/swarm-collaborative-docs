import { FeedIndex, PrivateKey, Signature, Topic } from '@ethersphere/bee-js'
import {
  MessageData,
  MessageType,
  Options,
  readSingleComment as readDoc,
  writeCommentToIndex as writeDoc,
} from '@solarpunkltd/comment-system'
import * as Y from 'yjs'

import { DocSettings, DocTransport, NotificationHandler, NotificationPayload } from '../interfaces'
import { validateStamps } from '../utils/bee'
import { decode, encode, indexStrToBigint, remove0x, retryAwaitableAsync, uuidV4 } from '../utils/common'
import { API_VERSION, DOC_FEED_SUFFIX, PLACEHOLDER_STAMP } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { EventEmitter } from '../utils/eventEmitter'

import { DOC_EVENTS } from './events'
import { Members } from './members'

const TAG = 'SwarmDoc'
const DEBOUNCE_MS = 500
const DEFAULT_MEMBER_LIST_POLL_INTERVAL_MS = 5000
const MIN_TTL_WARN_DAYS = 2

/**
 * Collaborative Yjs document backed by Swarm persistent storage.
 *
 * Each peer writes full Yjs state snapshots to their own per-user Swarm feed and
 * broadcasts incremental deltas to online peers via the configured `DocTransport`.
 * On startup, snapshots from all known peers are fetched and merged, so late-joining
 * peers converge to the same state without any central server.
 *
 * Lifecycle:
 * ```ts
 * const swarmDoc = new SwarmDoc(settings)
 * swarmDoc.start()                    // begins transport, snapshot fetch, member poll
 * // ... use swarmDoc.doc (Y.Doc) ...
 * swarmDoc.stop()                     // tears down transport and timers
 * ```
 */
export class SwarmDoc {
  /** The underlying Yjs document. Bind editors directly to this instance. */
  public readonly doc: Y.Doc

  private errorHandler = ErrorHandler.getInstance()
  private emitter: EventEmitter
  private signer: PrivateKey
  private ownAddress: string
  private username: string
  private ownIndex: bigint = -1n
  private docFeedId: string
  private docTopic: string
  private transport: DocTransport
  private beeApiUrl: string
  private mutableStampId: string
  private members: Members

  private pendingUpdates: Uint8Array[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private publishInFlight = false
  private fetchProcessRunning = false
  private memberListPollTimer: ReturnType<typeof setInterval> | null = null
  private localCursor: { anchor: number; head: number } | null = null
  private cursorTimer: ReturnType<typeof setInterval> | null = null

  constructor(settings: DocSettings) {
    this.doc = new Y.Doc()
    this.emitter = new EventEmitter()

    this.signer = new PrivateKey(remove0x(settings.user.privateKey))
    this.ownAddress = this.signer.publicKey().address().toString()
    this.username = settings.user.nickname
    this.beeApiUrl = settings.infra.beeUrl
    this.mutableStampId = settings.infra.mutableStamp || PLACEHOLDER_STAMP

    this.docFeedId = settings.infra.topic + DOC_FEED_SUFFIX
    this.docTopic = Topic.fromString(this.docFeedId).toString()

    this.members = new Members(this.docFeedId, this.beeApiUrl, this.mutableStampId)

    const configuredMembers = settings.infra.members
      ? Array.from(settings.infra.members.entries()).map(([addr, username]) => [remove0x(addr.toLowerCase()), username])
      : []
    const members = configuredMembers.filter(([addr]) => addr !== this.ownAddress)

    this.transport = settings.infra.transport({
      doc: this.doc,
      emitter: this.emitter,
      members: this.members,
      ownAddress: this.ownAddress,
      nickname: settings.user.nickname,
      onPeerDiscovered: (address: string, username: string) => {
        this.registerMember(address, username)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(address)
      },
      docFeedId: this.docFeedId,
      beeApiUrl: this.beeApiUrl,
      signer: this.signer,
      mutableStampId: this.mutableStampId,
    })

    for (const [memberAddress, memberUsername] of members) {
      this.registerMember(memberAddress, memberUsername)
    }
  }

  // Derive comment-system options for own doc feed
  private ownFeedOptions(): Options {
    return {
      identifier: Topic.fromString(this.docFeedId + this.ownAddress).toString(),
      address: this.ownAddress,
      beeApiUrl: this.beeApiUrl,
      stamp: this.mutableStampId,
      signer: this.signer,
    }
  }

  // Derive comment-system options for reading a peer's doc feed
  private memberFeedOptions(address: string): Options {
    return {
      identifier: Topic.fromString(this.docFeedId + address).toString(),
      address,
      beeApiUrl: this.beeApiUrl,
      stamp: this.mutableStampId,
    }
  }

  // Register a peer address so we can read their doc feed. No-op if already registered.
  private registerMember(address: string, username: string): void {
    if (!this.members.register(address, username)) {
      return
    }

    this.transport.connectToPeer(address)
    console.debug(`${TAG} registerMember: ${address.slice(0, 8)}…`)
  }

  /**
   * Starts the transport, subscribes to the doc topic, fetches peer snapshots,
   * and begins the member-list poll. Call once after constructing `SwarmDoc`.
   */
  public start(): void {
    this.transport.start()

    // Collect incremental Yjs updates; debounce into a single publish.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.isRemoteOrigin(origin)) {
        return
      }

      this.pendingUpdates.push(update)

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
      }

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
    this.startCursorBroadcast()
  }

  /**
   * Updates the local cursor position in the shared `Y.Text` and schedules a broadcast.
   * Call this from the editor's selection-change handler.
   *
   * @param cursor Character index offsets `{ anchor, head }`, or `null` to clear.
   */
  public updateCursor(cursor: { anchor: number; head: number } | null): void {
    this.localCursor = cursor
  }

  // Returns true for any origin that should not trigger a Swarm publish or RTC forward.
  private isRemoteOrigin(origin: unknown): boolean {
    return origin === 'remote' || (this.transport.isRemoteOrigin(origin) ?? false)
  }

  /** Stops the transport, clears all timers, and destroys the Yjs document. */
  public stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    if (this.memberListPollTimer) {
      clearInterval(this.memberListPollTimer)
      this.memberListPollTimer = null
    }

    if (this.cursorTimer) {
      clearInterval(this.cursorTimer)
      this.cursorTimer = null
    }

    this.transport.stop()
    this.emitter.cleanAll()
    this.fetchProcessRunning = false
    this.doc.destroy()
  }

  /** Returns the event emitter. Subscribe to `DOC_EVENTS` constants for doc lifecycle events. */
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
      const snapshot = encode(Y.encodeStateAsUpdate(this.doc))
      const delta = encode(Y.mergeUpdates(allUpdates))

      const nextIndex = this.ownIndex === -1n ? 0n : this.ownIndex + 1n
      console.log(
        `${TAG} publishSnapshot → index: ${nextIndex}, snapshot: ${(snapshot.length * 0.75) | 0}B, delta: ${(delta.length * 0.75) | 0}B`,
      )

      // TODO: sign messages
      const messageObj: MessageData = {
        id: uuidV4(),
        username: this.username,
        address: this.ownAddress,
        topic: this.docTopic,
        signature: '',
        timestamp: Date.now(),
        type: MessageType.TEXT,
        message: snapshot,
        index: FeedIndex.fromBigInt(nextIndex).toString(),
      }

      await writeDoc(messageObj, FeedIndex.fromBigInt(nextIndex), this.ownFeedOptions())
      this.ownIndex = nextIndex
      console.log(`${TAG} publishSnapshot ✓ index: ${this.ownIndex}`)

      const deltaBytes = decode(delta)
      const sig = this.signer.sign(deltaBytes).toHex()

      this.transport.publish({
        type: 'doc',
        v: API_VERSION,
        topic: this.docTopic,
        author: this.ownAddress,
        username: this.username,
        feedIndex: Number(nextIndex),
        delta,
        sig,
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
      await validateStamps(this.beeApiUrl, this.mutableStampId, MIN_TTL_WARN_DAYS, true, msg => {
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
    if (this.members.all().size === 0) {
      this.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)
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
    const membersList = await this.members.add(this.ownAddress, this.username)
    for (const [addr, username] of membersList) {
      if (addr !== this.ownAddress) {
        this.registerMember(addr, username)
      }
    }

    this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())

    // Announce presence to online peers
    this.transport.publish({
      type: 'join',
      v: API_VERSION,
      topic: this.docTopic,
      author: this.ownAddress,
      username: this.username,
    })
    console.log(`${TAG} initMemberList: join notification sent`)

    const members = this.members.all()
    console.log(`${TAG} initMemberList: ${members.size} peer(s) to fetch`)
    const memberPromises: Promise<void>[] = []
    members.forEach((addr: string, _username: string) => memberPromises.push(this.fetchLatestFromMember(addr)))
    await Promise.allSettled(memberPromises)
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

  /**
   * Reads the Swarm consensus member list and registers any newly discovered peers.
   * Call this to proactively discover peers without waiting for the periodic poll.
   */
  public async refreshMemberList(): Promise<void> {
    try {
      const members = await this.members.read()

      console.log(`${TAG} refreshMemberList members: `, members)

      if (!members || members.size === 0 || Object.keys(members).length === 0) {
        console.log(`${TAG} refreshMemberList: empty member list`)

        return
      }

      console.log(`${TAG} refreshMemberList: got [${Array.from(Object.keys(members)).join(', ')}]`)
      let changed = false
      for (const [addr, username] of members) {
        if (addr !== this.ownAddress && !this.members.has(addr)) {
          this.registerMember(addr, username)
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

        if (!members) {
          return
        }

        let changed = false
        for (const [addr, username] of members) {
          if (addr !== this.ownAddress && !this.members.has(addr)) {
            this.registerMember(addr, username)
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
    console.log(`${TAG} known members: ${Array.from(Object.keys(this.members.all())).join(', ') || '(none)'}`)

    const handler: NotificationHandler = (payload: NotificationPayload): void => {
      const author = remove0x(payload.author.toLowerCase())

      if (author === this.ownAddress) return

      if (payload.type === 'join') {
        console.log(`${TAG} notification: join from ${author.slice(0, 8)}…`)
        this.registerMember(author, payload.username)
        this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
        this.fetchLatestFromMember(author)

        return
      }

      if (payload.type === 'cursor') {
        this.emitter.emit(DOC_EVENTS.AWARENESS_UPDATED, {
          address: author,
          username: payload.username,
          cursor: payload.cursor,
        })

        return
      }

      if (payload.type !== 'doc') {
        console.warn(`${TAG} unknown payload type from ${author.slice(0, 8)}…`)

        return
      }

      if (!payload.delta) {
        console.warn(`${TAG} dropping message from ${author.slice(0, 8)}…, no delta provided`)

        return
      }

      if (!payload.sig) {
        console.warn(`${TAG} dropping unsigned delta from ${author.slice(0, 8)}…`)

        return
      }

      try {
        const valid = new Signature(payload.sig).isValid(decode(payload.delta), author)

        if (!valid) {
          console.warn(`${TAG} dropping delta with invalid signature from ${author.slice(0, 8)}…`)

          return
        }
      } catch {
        console.warn(`${TAG} signature verification error from ${author.slice(0, 8)}… — dropping`)

        return
      }

      console.log(
        `${TAG} notification: author=${author.slice(0, 8)}…, feedIndex=${payload.feedIndex}, hasDelta=${Boolean(payload.delta)}`,
      )
      this.fetchLatestFromMember(author, BigInt(payload.feedIndex), payload.delta)
    }

    this.transport.subscribe(this.docTopic, handler)
  }

  private startCursorBroadcast(): void {
    this.cursorTimer = setInterval(() => {
      this.transport.publish({
        type: 'cursor',
        v: API_VERSION,
        topic: this.docTopic,
        author: this.ownAddress,
        username: this.username,
        cursor: this.localCursor,
      })
    }, DEBOUNCE_MS)
  }
}
