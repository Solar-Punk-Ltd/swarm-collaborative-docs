import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'
import { MessageData, MessageType, Options, readSingleComment, writeCommentToIndex } from '@solarpunkltd/comment-system'
import { v4 as uuidv4 } from 'uuid'
import * as Y from 'yjs'

import { DocSettings, NotificationProvider } from '../interfaces'
import { indexStrToBigint, remove0x, retryAwaitableAsync } from '../utils/common'
import { ErrorHandler } from '../utils/error'
import { EventEmitter } from '../utils/eventEmitter'

import { DOC_EVENTS, PLACEHOLDER_STAMP } from './constants'
import { SwarmManifest } from './manifest'

const DEBOUNCE_MS = 500
const TAG = '[SwarmDoc]'

// base64 encode/decode — ~33% overhead vs raw binary, vs 100% for hex
function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export class SwarmDoc {
  public readonly doc: Y.Doc

  private errorHandler = ErrorHandler.getInstance()
  private emitter: EventEmitter
  private signer: PrivateKey
  private ownAddress: string
  private ownIndex: bigint = -1n
  private rawTopic: string
  private topic: string
  private commentOptions: Options // own feed read options (no stamp needed for reads)
  private snapshotOptions: Options // own feed write options with mutable stamp
  private memberOptions: Map<string, Options> = new Map()
  private memberIndices: Map<string, bigint> = new Map()
  private notificationProvider: NotificationProvider
  private beeApiUrl: string
  private mutableStampId: string

  private manifest: SwarmManifest
  private regularStamp: string

  private pendingUpdates: Uint8Array[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private publishInFlight = false
  private fetchProcessRunning = false
  private manifestPollTimer: ReturnType<typeof setInterval> | null = null

  constructor(settings: DocSettings) {
    this.doc = new Y.Doc()
    this.emitter = new EventEmitter()

    this.signer = new PrivateKey(remove0x(settings.user.privateKey))
    this.ownAddress = this.signer.publicKey().address().toString()
    this.beeApiUrl = settings.infra.beeUrl
    this.mutableStampId = settings.infra.mutableStamp || PLACEHOLDER_STAMP
    this.regularStamp = settings.infra.stamp || PLACEHOLDER_STAMP

    // _doc suffix separates doc feeds from comment feeds on the same topic
    this.rawTopic = settings.infra.topic + '_doc'
    this.topic = Topic.fromString(this.rawTopic).toString()

    this.commentOptions = {
      identifier: Topic.fromString(this.rawTopic + this.ownAddress).toString(),
      address: this.ownAddress,
      beeApiUrl: settings.infra.beeUrl,
      stamp: this.regularStamp,
      signer: this.signer,
    }

    // Snapshot writes use the mutable stamp so old chunks get recycled on Swarm
    this.snapshotOptions = {
      ...this.commentOptions,
      stamp: this.mutableStampId,
    }

    // Manifest uses the mutable stamp — each member join overwrites the previous entry
    this.manifest = new SwarmManifest(this.rawTopic, this.beeApiUrl, this.mutableStampId)

    const members = (settings.infra.members || [])
      .map(addr => remove0x(addr.toLowerCase()))
      .filter(addr => addr !== this.ownAddress)

    console.log(`${TAG} ownAddress: ${this.ownAddress}`)
    console.log(`${TAG} rawTopic: ${this.rawTopic}`)
    console.log(`${TAG} own feed identifier: ${this.commentOptions.identifier}`)
    console.log(`${TAG} members configured: ${members.length === 0 ? '(none)' : members.join(', ')}`)
    console.log(`${TAG} mutable stamp: ${this.mutableStampId}`)

    for (const memberAddress of members) {
      this.registerMember(memberAddress)
    }

    this.notificationProvider = settings.infra.notificationProvider
  }

  // Register a peer address so we can read their doc feed.
  // No-op if already registered.
  private registerMember(address: string): void {
    if (this.memberOptions.has(address)) return
    const identifier = Topic.fromString(this.rawTopic + address).toString()
    this.memberIndices.set(address, -1n)
    this.memberOptions.set(address, {
      identifier,
      address,
      beeApiUrl: this.beeApiUrl,
      stamp: this.regularStamp,
    })
    this.notificationProvider.addMember?.(address)
    console.log(`${TAG} registerMember: ${address.slice(0, 8)}…`)
  }

  public start(): void {
    // Collect incremental Yjs updates; debounce into a single publish.
    // origin === 'remote' = we applied this from a peer, skip to avoid echo.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return
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
    // this.startManifestPoll();
  }

  public stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    if (this.manifestPollTimer) {
      clearInterval(this.manifestPollTimer)
      this.manifestPollTimer = null
    }
    this.emitter.cleanAll()
    this.notificationProvider.unsubscribe()
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
      this.errorHandler.handleError(err, `SwarmDoc.applyYjsBytes [${label}]`)
    }
  }

  private async publishSnapshot(capturedUpdates: Uint8Array[]): Promise<void> {
    if (this.publishInFlight) {
      // Another publish is in flight — re-queue the captured updates
      this.pendingUpdates.push(...capturedUpdates)

      return
    }

    this.publishInFlight = true
    try {
      // Full snapshot → written to Swarm with mutable stamp (old chunks get recycled)
      const snapshot = encode(Y.encodeStateAsUpdate(this.doc))

      // Delta → sent in notification payload for peers already online (no Swarm read needed)
      const delta = encode(Y.mergeUpdates(capturedUpdates))

      const nextIndex = this.ownIndex === -1n ? 0n : this.ownIndex + 1n
      console.log(
        `${TAG} publishSnapshot → index: ${nextIndex}, snapshot bytes: ${(snapshot.length * 0.75) | 0}, delta bytes: ${(delta.length * 0.75) | 0}`,
      )

      const messageObj: MessageData = {
        id: uuidv4(),
        username: this.ownAddress,
        address: this.ownAddress,
        topic: this.topic,
        signature: '',
        timestamp: Date.now(),
        type: MessageType.TEXT,
        message: snapshot,
        index: FeedIndex.fromBigInt(nextIndex).toString(),
      }

      await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(nextIndex), this.snapshotOptions)
      this.ownIndex = nextIndex
      console.log(`${TAG} publishSnapshot ✓ index saved: ${this.ownIndex}`)

      this.notificationProvider.publish({
        topic: this.topic,
        author: this.ownAddress,
        feedIndex: Number(nextIndex),
        deltaRef: '',
        delta,
      })
    } catch (err) {
      this.errorHandler.handleError(err, 'SwarmDoc.publishSnapshot')
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)
    } finally {
      this.publishInFlight = false

      // If more updates arrived while we were publishing, publish again
      if (this.pendingUpdates.length > 0) {
        const next = [...this.pendingUpdates]
        this.pendingUpdates = []
        this.publishSnapshot(next)
      }
    }
  }

  private async validateStamps(): Promise<void> {
    const bee = new Bee(this.beeApiUrl)
    const batches = await bee.getPostageBatches()
    const usable = batches.filter(s => s.usable)

    const regularStamp = this.commentOptions.stamp

    if (regularStamp && regularStamp !== PLACEHOLDER_STAMP) {
      const found = usable.find(s => s.batchID.toString() === regularStamp)

      if (!found) throw new Error(`Stamp ${regularStamp} is not usable`)
      console.log(`${TAG} stamp OK: ${regularStamp}`)
    }

    if (this.mutableStampId && this.mutableStampId !== PLACEHOLDER_STAMP) {
      const found = usable.find(s => s.batchID.toString() === this.mutableStampId)

      if (!found) throw new Error(`Mutable stamp ${this.mutableStampId} is not usable`)

      if (found.immutableFlag === true) {
        throw new Error(`Stamp ${this.mutableStampId} has immutableFlag=true — must be a mutable batch`)
      }
      console.log(`${TAG} mutable stamp OK: ${this.mutableStampId} (immutableFlag=${found.immutableFlag})`)
    }
  }

  private async init(): Promise<void> {
    console.log(`${TAG} init: starting`)
    try {
      await this.validateStamps()
    } catch (err) {
      this.errorHandler.handleError(err, 'SwarmDoc.validateStamps')
      this.emitter.emit(DOC_EVENTS.DOC_ERROR, err)

      return
    }
    await Promise.allSettled([this.initOwnIndex(), this.initManifest()])
    console.log(`${TAG} init: done — ownIndex: ${this.ownIndex}`)
  }

  private async initOwnIndex(): Promise<void> {
    console.log(`${TAG} initOwnIndex: reading own feed`)
    const comment = await retryAwaitableAsync(() => readSingleComment(undefined, this.commentOptions), 10, 1000)

    if (!comment) {
      console.error(`${TAG} no comment found`)

      return
    }

    const parsedIx = indexStrToBigint(comment.index)
    console.log(`${TAG} initOwnIndex: latest index on Swarm = ${parsedIx ?? 'none'}`)

    if (parsedIx !== undefined && !FeedIndex.fromBigInt(parsedIx).equals(FeedIndex.MINUS_ONE)) {
      this.ownIndex = parsedIx
      console.log(`${TAG} initOwnIndex: restoring own snapshot at index ${parsedIx}`)
      this.applyYjsBytes(comment.message, `own idx=${parsedIx}`)
    } else {
      console.log(`${TAG} initOwnIndex: no previous writes, starting fresh`)
    }
  }

  private async initManifest(): Promise<void> {
    // Register own address in the consensus manifest, then fetch latest state
    // from every peer listed there (merging with any statically configured members).
    const manifestMembers = await this.manifest.addMember(this.ownAddress)
    for (const addr of manifestMembers) {
      if (addr !== this.ownAddress) this.registerMember(addr)
    }
    this.emitter.emit(DOC_EVENTS.MANIFEST_UPDATED, [...this.memberOptions.keys()])

    // Announce presence so online peers can discover and subscribe to this user.
    // feedIndex: -1 is the join sentinel — no doc content, just "I'm here".
    this.notificationProvider.publish({
      topic: this.topic,
      author: this.ownAddress,
      feedIndex: -1,
      deltaRef: '',
    })
    console.log(`${TAG} initManifest: join notification sent`)

    const members = [...this.memberOptions.keys()]
    console.log(`${TAG} initManifest: ${members.length} peer(s) to fetch`)
    await Promise.allSettled(members.map(addr => this.fetchLatestFromMember(addr)))
  }

  // targetIndex + delta: from a notification (peer is online, delta is available immediately).
  // No targetIndex: init path — read latest from Swarm.
  private async fetchLatestFromMember(memberAddress: string, targetIndex?: bigint, delta?: string): Promise<void> {
    const options = this.memberOptions.get(memberAddress)

    if (!options) {
      console.log(`${TAG} fetchLatestFromMember: ${memberAddress} not in memberOptions, skipping`)

      return
    }

    const lastKnown = this.memberIndices.get(memberAddress) ?? -1n

    // Fast path: notification carries the delta — no Swarm read needed
    if (targetIndex !== undefined && delta !== undefined) {
      if (targetIndex <= lastKnown) {
        console.log(`${TAG} fetchLatestFromMember: ${memberAddress} index ${targetIndex} already applied`)

        return
      }
      console.log(
        `${TAG} fetchLatestFromMember: ${memberAddress} applying delta from notification (idx=${targetIndex})`,
      )
      this.memberIndices.set(memberAddress, targetIndex)
      this.applyYjsBytes(delta, `${memberAddress.slice(0, 8)} delta idx=${targetIndex}`)

      return
    }

    // Slow path: read from Swarm (init, or fallback if notification had no delta)
    try {
      let comment: Awaited<ReturnType<typeof readSingleComment>>
      let targetIx: bigint

      if (targetIndex !== undefined) {
        if (targetIndex <= lastKnown) return
        console.log(`${TAG} fetchLatestFromMember: ${memberAddress} waiting for index ${targetIndex} on Swarm`)
        comment = await retryAwaitableAsync(
          () => readSingleComment(FeedIndex.fromBigInt(targetIndex), options),
          10,
          1000,
        )

        if (!comment) {
          console.log(`${TAG} fetchLatestFromMember: ${memberAddress} index ${targetIndex} not available after retries`)

          return
        }
        targetIx = targetIndex
      } else {
        comment = await readSingleComment(undefined, options)
        const parsedIx = indexStrToBigint(comment?.index)
        console.log(
          `${TAG} fetchLatestFromMember: ${memberAddress} latestOnSwarm=${parsedIx ?? 'none'} lastKnown=${lastKnown}`,
        )

        if (!comment || parsedIx === undefined || parsedIx <= lastKnown) return
        targetIx = parsedIx
      }

      this.memberIndices.set(memberAddress, targetIx)
      console.log(`${TAG} fetchLatestFromMember: ${memberAddress} applying snapshot at index ${targetIx}`)
      this.applyYjsBytes(comment.message, `${memberAddress.slice(0, 8)} snapshot idx=${targetIx}`)
    } catch (err) {
      this.errorHandler.handleError(err, `SwarmDoc.fetchLatestFromMember(${memberAddress})`)
    }
  }

  public async refreshManifest(): Promise<void> {
    try {
      const members = await this.manifest.read()
      console.log(`${TAG} refreshManifest: manifest returned [${members.join(', ')}]`)
      let changed = false
      for (const addr of members) {
        if (addr !== this.ownAddress && !this.memberOptions.has(addr)) {
          this.registerMember(addr)
          this.fetchLatestFromMember(addr)
          changed = true
        }
      }

      if (changed) {
        this.emitter.emit(DOC_EVENTS.MANIFEST_UPDATED, [...this.memberOptions.keys()])
      } else {
        console.log(`${TAG} refreshManifest: no new members (known: [${[...this.memberOptions.keys()].join(', ')}])`)
      }
    } catch (err) {
      this.errorHandler.handleError(err, 'SwarmDoc.refreshManifest')
    }
  }

  private startManifestPoll(): void {
    const INTERVAL_MS = 5000
    this.manifestPollTimer = setInterval(async () => {
      try {
        const members = await this.manifest.read()
        let changed = false
        for (const addr of members) {
          if (addr !== this.ownAddress && !this.memberOptions.has(addr)) {
            this.registerMember(addr)
            this.fetchLatestFromMember(addr)
            changed = true
          }
        }

        if (changed) {
          this.emitter.emit(DOC_EVENTS.MANIFEST_UPDATED, [...this.memberOptions.keys()])
        }
      } catch {
        // silent — manifest unavailable is not fatal
      }
    }, INTERVAL_MS)
  }

  private startFetchProcess(): void {
    if (this.fetchProcessRunning) return
    this.fetchProcessRunning = true
    console.log(`${TAG} subscribing to topic: ${this.topic}`)
    console.log(`${TAG} known members: ${[...this.memberOptions.keys()].join(', ') || '(none)'}`)
    this.notificationProvider.subscribe(this.topic, payload => {
      const author = remove0x(payload.author.toLowerCase())

      if (author === this.ownAddress) {
        console.log(`${TAG} notification: from self, ignoring`)

        return
      }

      // feedIndex: -1 = join notification — register peer and fetch their latest snapshot
      if (payload.feedIndex === -1) {
        console.log(`${TAG} notification: join from ${author}`)
        this.registerMember(author)
        this.emitter.emit(DOC_EVENTS.MANIFEST_UPDATED, [...this.memberOptions.keys()])
        this.fetchLatestFromMember(author)

        return
      }

      console.log(
        `${TAG} notification: author=${author}, feedIndex=${payload.feedIndex}, hasDelta=${Boolean(payload.delta)}`,
      )
      this.fetchLatestFromMember(author, BigInt(payload.feedIndex), payload.delta)
    })
  }
}
