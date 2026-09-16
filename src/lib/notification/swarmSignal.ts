import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { ISwarmSignal, SignalFeedPayload, SignalRecord } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { SIGNAL_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

const TAG = 'SwarmSignal'
const MAX_DRAIN_PER_READ = 20

/*
 * Structural, so it survives bee-js accessor churn. Only indexed reads are used: an unindexed
 * download makes Bee search the network for the latest update and negative-cache the miss, which
 * delayed offer/answer discovery by 18–34 s. Signal feeds are append-only from index 0, so the
 * index is always known and every read is a direct chunk lookup.
 */
interface IndexedFeedReader {
  downloadPayload(options: { index: FeedIndex }): Promise<{ payload: { toUtf8(): string } }>
}

export class SwarmSignal implements ISwarmSignal {
  private readonly bee: Bee
  private readonly ownSigner: PrivateKey
  private readonly ownAddress: string
  private readonly topic: Topic
  private readonly stamp: string
  private currentIndex: bigint = -1n
  private ownIndexResolved = false
  private readonly peerNextIndexes: Map<string, bigint> = new Map()
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

  async read(peerAddress: string): Promise<SignalFeedPayload | null> {
    const reader = this.bee.feed.makeReader(this.topic, new EthAddress(peerAddress))
    const label = `read(${peerAddress.slice(0, 8)}…)`
    let next = this.peerNextIndexes.get(peerAddress) ?? 0n
    let latest: SignalFeedPayload | null = null

    // Each payload carries the peer's full record set, so the newest readable index wins.
    for (let i = 0; i < MAX_DRAIN_PER_READ; i++) {
      const payload = await this.readIndex(reader, next, label)

      if (!payload) break

      latest = payload
      next += 1n
    }

    this.peerNextIndexes.set(peerAddress, next)

    return latest
  }

  private async readIndex(reader: IndexedFeedReader, index: bigint, label: string): Promise<SignalFeedPayload | null> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })

      return JSON.parse(result.payload.toUtf8()) as SignalFeedPayload
    } catch (err) {
      if (!isNotFoundError(err)) {
        this.errorHandler.handleError(err, `${TAG}.${label}`)
      }

      return null
    }
  }

  // eslint-disable-next-line require-await
  async writeRecord(record: SignalRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.readOwn()
      const filtered = current.records.filter(r => !(r.type === record.type && r.toAddress === record.toAddress))
      await this.writePayload({ records: [...filtered, record] })

      this.logger.debug(
        `${TAG} writeRecord type=${record.type} to=${record.toAddress.slice(0, 8)}… sessionId=${record.sessionId.slice(0, 8)}`,
      )
    })

    return this.writeQueue
  }

  // eslint-disable-next-line require-await
  async clearOwn(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.readOwn()

      if (current.records.length === 0) {
        return
      }

      await this.writePayload({ records: [] })

      this.logger.debug(`${TAG} clearOwn: cleared ${current.records.length} stale record(s)`)
    })

    return this.writeQueue
  }

  private async readOwn(): Promise<SignalFeedPayload> {
    const reader = this.bee.feed.makeReader(this.topic, this.ownAddress)

    // We are the only writer, so the tail is found once and then tracked in memory.
    if (!this.ownIndexResolved) {
      let latest: SignalFeedPayload = { records: [] }
      let next = 0n

      for (let i = 0; i < MAX_DRAIN_PER_READ; i++) {
        const payload = await this.readIndex(reader, next, 'readOwn')

        if (!payload) break

        latest = payload
        this.currentIndex = next
        next += 1n
      }

      this.ownIndexResolved = true

      return latest
    }

    if (this.currentIndex < 0n) {
      return { records: [] }
    }

    return (await this.readIndex(reader, this.currentIndex, 'readOwn')) ?? { records: [] }
  }

  private async writePayload(payload: SignalFeedPayload): Promise<void> {
    const nextIndex = this.currentIndex === -1n ? 0n : this.currentIndex + 1n
    const writer = this.bee.feed.makeWriter(this.topic, this.ownSigner)

    try {
      await writer.uploadPayload(this.stamp, JSON.stringify(payload), {
        index: FeedIndex.fromBigInt(nextIndex),
        deferred: false,
      })
      this.currentIndex = nextIndex
      this.logger.debug(`${TAG} writePayload ✓ index: ${nextIndex}`)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.writePayload`)
    }
  }
}
