import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { DocFeedEntry, DocFeedRecord, IDocFeed } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { API_VERSION } from '../utils/constants'
import { ErrorHandler } from '../utils/error'

const TAG = 'DocFeed'
const MAX_DRAIN_PER_READ = 20

/**
 * Reads and writes per-user document snapshot feeds.
 *
 * Each peer owns one feed per room, identified by the room topic plus the peer's own address,
 * holding the peer's latest full `Y.Doc` state at every index. The feed index comes back from
 * Bee itself, so it is never stored inside the payload.
 *
 * Reads are always by explicit index. An unindexed download makes Bee search the network for the
 * latest update and negative-cache the miss, which is slow and returns stale misses for tens of
 * seconds after a write.
 */
export class DocFeed implements IDocFeed {
  private readonly bee: Bee
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()

  constructor(beeUrl: string, stamp: string) {
    this.bee = new Bee(beeUrl)
    this.stamp = stamp
  }

  async read(topic: Topic, owner: string, index: FeedIndex): Promise<DocFeedEntry | null> {
    try {
      const reader = this.bee.feed.makeReader(topic, owner)
      const result = await reader.downloadPayload({ index })
      const record = JSON.parse(result.payload.toUtf8()) as DocFeedRecord

      if (!record?.snapshot) {
        return null
      }

      return { index: result.feedIndex.toBigInt(), snapshot: record.snapshot, timestamp: record.timestamp }
    } catch (err) {
      if (!isNotFoundError(err)) {
        this.errorHandler.handleError(err, `${TAG}.read(${owner.slice(0, 8)}…)`)
      }

      return null
    }
  }

  async readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null> {
    let next = fromIndex < 0n ? 0n : fromIndex
    let latest: DocFeedEntry | null = null

    // Every entry is a full state snapshot, so only the newest readable one is needed.
    for (let i = 0; i < MAX_DRAIN_PER_READ; i++) {
      const entry = await this.read(topic, owner, FeedIndex.fromBigInt(next))

      if (!entry) break

      latest = entry
      next += 1n
    }

    return latest
  }

  async write(topic: Topic, signer: PrivateKey, index: FeedIndex, snapshot: string): Promise<void> {
    const record: DocFeedRecord = { v: API_VERSION, snapshot, timestamp: Date.now() }
    const writer = this.bee.feed.makeWriter(topic, signer)

    await writer.uploadPayload(this.stamp, JSON.stringify(record), { index, deferred: false })
  }
}
