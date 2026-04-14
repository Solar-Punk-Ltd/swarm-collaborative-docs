import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { SignalFeedPayload, SignalRecord } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { PLACEHOLDER_STAMP, SIGNAL_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'

const TAG = 'SwarmSignal'

function isServerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return error.message?.includes('500') || false
}

export class SwarmSignal {
  private readonly bee: Bee
  private readonly ownSigner: PrivateKey
  private readonly ownAddress: string
  private readonly topic: Topic
  private readonly stamp: string
  private currentIndex: bigint = -1n
  private readonly peerLastIndexes: Map<string, bigint> = new Map()
  private readonly errorHandler = ErrorHandler.getInstance()
  // Ensures clearOwn and writeRecord never run concurrently (prevents double-writes at same index)
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(rawTopic: string, beeUrl: string, ownSigner: PrivateKey, stamp: string) {
    const signalFeedId = rawTopic + SIGNAL_FEED_SUFFIX
    this.topic = Topic.fromString(signalFeedId)
    this.ownSigner = ownSigner
    this.ownAddress = ownSigner.publicKey().address().toString()
    this.bee = new Bee(beeUrl)
    this.stamp = stamp || PLACEHOLDER_STAMP
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Reads the signal feed of any peer. Returns null if the feed doesn't exist yet or has no new data.
   *  After the first read, uses forward-indexed lookup (lastIndex + 1) to bypass Bee node "latest" cache. */
  async read(peerAddress: string): Promise<SignalFeedPayload | null> {
    const reader = this.bee.makeFeedReader(this.topic, new EthAddress(peerAddress))
    const lastIndex = this.peerLastIndexes.get(peerAddress)

    try {
      const result = await reader.downloadPayload(
        lastIndex === undefined ? undefined : { index: FeedIndex.fromBigInt(lastIndex + 1n) },
      )

      this.peerLastIndexes.set(peerAddress, result.feedIndex.toBigInt())

      return JSON.parse(result.payload.toUtf8()) as SignalFeedPayload
    } catch (err) {
      // 404 = no new entry yet (normal); 500 = transient Bee node error — both are non-fatal
      if (!isNotFoundError(err) && !isServerError(err)) {
        this.errorHandler.handleError(err, `${TAG}.read(${peerAddress.slice(0, 8)}…)`)
      }

      return null
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Appends (or replaces) a signal record in own feed.
   * Deduplication key: type + toAddress — only one active offer/answer per peer.
   * Enqueued so it never runs concurrently with clearOwn.
   */
  async writeRecord(record: SignalRecord): Promise<void> {
    console.log(
      `${TAG} writeRecord called — type=${record.type} to=${record.toAddress.slice(0, 8)}… sessionId=${record.sessionId.slice(0, 8)} ts=${record.timestamp}`,
    )
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.readOwn()
      const filtered = current.records.filter(r => !(r.type === record.type && r.toAddress === record.toAddress))
      await this.writePayload({ records: [...filtered, record] })
    })

    return this.writeQueue
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Writes an empty payload to own feed, removing all stale records from the previous session.
   *  Enqueued so it never runs concurrently with writeRecord. */
  async clearOwn(): Promise<void> {
    console.log(`${TAG} clearOwn: starting`)
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.readOwn()

      if (current.records.length === 0) return

      await this.writePayload({ records: [] })
      console.log(`${TAG} clearOwn: cleared ${current.records.length} stale record(s)`)
    })

    return this.writeQueue
  }

  private async readOwn(): Promise<SignalFeedPayload> {
    try {
      const reader = this.bee.makeFeedReader(this.topic, this.ownAddress)
      // Use explicit index when known — avoids Bee node "latest" cache returning a stale value
      const result = await reader.downloadPayload(
        this.currentIndex >= 0n ? { index: FeedIndex.fromBigInt(this.currentIndex) } : undefined,
      )
      this.currentIndex = result.feedIndex.toBigInt()

      return JSON.parse(result.payload.toUtf8()) as SignalFeedPayload
    } catch (err) {
      if (!isNotFoundError(err) && !isServerError(err)) {
        this.errorHandler.handleError(err, `${TAG}.readOwn`)
      }

      return { records: [] }
    }
  }

  private async writePayload(payload: SignalFeedPayload): Promise<void> {
    const nextIndex = this.currentIndex === -1n ? 0n : this.currentIndex + 1n
    const writer = this.bee.makeFeedWriter(this.topic, this.ownSigner)

    try {
      await writer.uploadPayload(this.stamp, JSON.stringify(payload), {
        index: FeedIndex.fromBigInt(nextIndex),
        deferred: false,
      })
      this.currentIndex = nextIndex
      console.log(`${TAG} writePayload ✓ index: ${nextIndex}`)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.writePayload`)
    }
  }
}
