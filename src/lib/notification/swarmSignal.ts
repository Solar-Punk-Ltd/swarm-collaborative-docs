import type { FeedReader } from '@ethersphere/bee-js'
import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { ISwarmSignal, SignalFeedPayload, SignalRecord } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { DEFERRED_FEED_UPLOAD, SIGNAL_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'SwarmSignal'
// Short: a peer's next signal index holds the offer or answer being waited for.
const SIGNAL_PROBE_BACKOFF_MS = [2_000, 4_000, 8_000]

export class SwarmSignal implements ISwarmSignal {
  private readonly bee: Bee
  private readonly ownSigner: PrivateKey
  private readonly ownAddress: string
  private readonly topic: Topic
  private readonly stamp: string
  private currentIndex: bigint = -1n
  private ownIndexResolved = false
  private stopped = false
  private readonly peerNextIndexes: Map<string, bigint> = new Map()
  private readonly probe = new FeedProbe(SIGNAL_PROBE_BACKOFF_MS)
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(rawTopic: string, beeUrl: string, ownSigner: PrivateKey, stamp: string) {
    const signalFeedId = rawTopic + SIGNAL_FEED_SUFFIX
    this.topic = Topic.fromString(signalFeedId)
    this.ownSigner = ownSigner
    this.ownAddress = ownSigner.publicKey().address().toString()
    this.bee = new Bee(beeUrl)
    this.stamp = stamp
  }

  // Always by explicit index: Bee's feed search delayed offer/answer discovery.
  async read(peerAddress: string): Promise<SignalFeedPayload | null> {
    const reader = this.bee.feed.makeReader(this.topic, new EthAddress(peerAddress))
    const { latest, next } = await drainFeed(
      index => this.readIndex(reader, index),
      this.peerNextIndexes.get(peerAddress) ?? 0n,
      peerAddress,
      this.probe,
      `${TAG} read(${peerAddress.slice(0, 8)}…)`,
    )

    this.peerNextIndexes.set(peerAddress, next)

    return latest
  }

  private async readIndex(reader: FeedReader, index: bigint): Promise<FeedRead<SignalFeedPayload>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })

      return { status: 'ok', payload: JSON.parse(result.payload.toUtf8()) as SignalFeedPayload }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  // eslint-disable-next-line require-await
  async writeRecord(record: SignalRecord): Promise<void> {
    return this.enqueue('writeRecord', async () => {
      const current = await this.readOwn()
      const filtered = current.records.filter(r => !(r.type === record.type && r.toAddress === record.toAddress))
      await this.writePayload({ records: [...filtered, record] })

      this.logger.debug(
        `${TAG} writeRecord type=${record.type} to=${record.toAddress.slice(0, 8)}… sessionId=${record.sessionId.slice(0, 8)}`,
      )
    })
  }

  // eslint-disable-next-line require-await
  async clearOwn(): Promise<void> {
    return this.enqueue('clearOwn', async () => {
      const current = await this.readOwn()

      if (current.records.length === 0) {
        return
      }

      await this.writePayload({ records: [] })

      this.logger.debug(`${TAG} clearOwn: cleared ${current.records.length} stale record(s)`)
    })
  }

  stop(): void {
    this.stopped = true
  }

  // Serialised, since each write reads the tail the previous one produced. Errors are caught to keep the chain alive.
  private enqueue(label: string, task: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.stopped) return

      try {
        await task()
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.${label}`)
      }
    })

    return this.writeQueue
  }

  private async readOwn(): Promise<SignalFeedPayload> {
    const reader = this.bee.feed.makeReader(this.topic, this.ownAddress)

    // We are the only writer, so the tail is found once and then tracked in memory.
    if (!this.ownIndexResolved) {
      this.currentIndex = await this.resolveOwnTail(reader)
      this.ownIndexResolved = true
      this.logger.debug(`${TAG} own feed tail resolved at index ${this.currentIndex}`)
    }

    if (this.currentIndex < 0n) {
      return { records: [] }
    }

    const result = await this.readIndex(reader, this.currentIndex)

    return result.status === 'ok' ? result.payload : { records: [] }
  }

  // An empty head lookup is trusted: confirming it would probe index 0, which our first record is about to use.
  private async resolveOwnTail(reader: FeedReader): Promise<bigint> {
    const head = await this.latestIndex(reader)

    if (head === null) {
      return -1n
    }

    return await resolveFeedTail(
      () => Promise.resolve(head),
      index => this.readIndex(reader, index),
      TAG,
    )
  }

  // Bee's head lookup; `null` on a miss or error, and the forward walk takes over.
  private async latestIndex(reader: FeedReader): Promise<bigint | null> {
    try {
      return (await reader.downloadPayload()).feedIndex.toBigInt()
    } catch (err) {
      if (!isNotFoundError(err)) {
        this.logger.debug(`${TAG} feed head lookup failed, walking from 0 instead: ${String(err)}`)
      }

      return null
    }
  }

  private async writePayload(payload: SignalFeedPayload): Promise<void> {
    const nextIndex = this.currentIndex + 1n
    const writer = this.bee.feed.makeWriter(this.topic, this.ownSigner)

    // Claimed before the upload and kept on failure: a failed write may still have stored its chunk.
    this.currentIndex = nextIndex

    try {
      await writer.uploadPayload(this.stamp, JSON.stringify(payload), {
        index: FeedIndex.fromBigInt(nextIndex),
        deferred: DEFERRED_FEED_UPLOAD,
      })
      this.logger.debug(`${TAG} writePayload ✓ index: ${nextIndex}`)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.writePayload(index ${nextIndex})`)
    }
  }
}
