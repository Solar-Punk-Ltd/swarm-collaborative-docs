import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { DocFeedEntry, DocFeedRecord, IDocFeed } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { API_VERSION, DEFERRED_FEED_UPLOAD } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'DocFeed'

/**
 * Reads and writes per-user document snapshot feeds.
 *
 * Each peer owns one feed per room, identified by the room topic plus the peer's own address,
 * holding the peer's latest full `Y.Doc` state at every index. The feed index comes back from
 * Bee itself, so it is never stored inside the payload.
 *
 * Reads are by explicit index, except when resolving a feed's tail. An unindexed download runs
 * Bee's feed search, whose probes time out after one second each and count that as a miss, so it
 * under-reports on a loaded node — fine to start a tail resolution from, since that is confirmed
 * forward afterwards, and wrong for the polling path, where an under-report hides a peer's writes.
 */
export class DocFeed implements IDocFeed {
  private readonly bee: Bee
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private readonly probe = new FeedProbe()

  constructor(beeUrl: string, stamp: string) {
    this.bee = new Bee(beeUrl)
    this.stamp = stamp
  }

  async read(topic: Topic, owner: string, index: FeedIndex): Promise<DocFeedEntry | null> {
    const result = await this.readIndex(topic, owner, index.toBigInt())

    if (result.status === 'failed') {
      this.errorHandler.handleError(result.error, `${TAG}.read(${owner.slice(0, 8)}…)`)
    }

    return result.status === 'ok' ? result.payload : null
  }

  async readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null> {
    const { latest } = await drainFeed(
      index => this.readIndex(topic, owner, index),
      fromIndex,
      owner,
      this.probe,
      `${TAG} ${owner.slice(0, 8)}…`,
    )

    return latest
  }

  /** Highest index present in a feed, or `-1n` if it holds nothing yet. */
  async resolveTail(topic: Topic, owner: string): Promise<bigint> {
    return await resolveFeedTail(
      () => this.latestIndex(topic, owner),
      index => this.readIndex(topic, owner, index),
      `${TAG}(${owner.slice(0, 8)}…)`,
    )
  }

  // Bee's own feed lookup. A miss means an empty feed; an error means the lookup itself is
  // unavailable, and the forward walk from index 0 answers the question without it.
  private async latestIndex(topic: Topic, owner: string): Promise<bigint | null> {
    try {
      const reader = this.bee.feed.makeReader(topic, owner)

      return (await reader.downloadPayload()).feedIndex.toBigInt()
    } catch (err) {
      if (!isNotFoundError(err)) {
        this.logger.debug(`${TAG} feed head lookup failed, walking from 0 instead: ${String(err)}`)
      }

      return null
    }
  }

  private async readIndex(topic: Topic, owner: string, index: bigint): Promise<FeedRead<DocFeedEntry>> {
    try {
      const reader = this.bee.feed.makeReader(topic, owner)
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })
      const record = JSON.parse(result.payload.toUtf8()) as DocFeedRecord

      if (!record?.snapshot) {
        return { status: 'absent' }
      }

      return {
        status: 'ok',
        payload: { index: result.feedIndex.toBigInt(), snapshot: record.snapshot, timestamp: record.timestamp },
      }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  async write(topic: Topic, signer: PrivateKey, index: FeedIndex, snapshot: string): Promise<void> {
    const record: DocFeedRecord = { v: API_VERSION, snapshot, timestamp: Date.now() }
    const writer = this.bee.feed.makeWriter(topic, signer)

    await writer.uploadPayload(this.stamp, JSON.stringify(record), { index, deferred: DEFERRED_FEED_UPLOAD })
  }
}
