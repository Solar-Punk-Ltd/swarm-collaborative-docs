import type { SOCReader } from '@ethersphere/bee-js'
import { Bee, Bytes, FeedIndex, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js'

import { DocFeedEntry, DocFeedRecord, IDocFeed } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { API_VERSION, DEFERRED_FEED_UPLOAD } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'DocFeed'
// One-chunk probes per catch-up: a writer saving after every 500 ms pause adds up to 30 entries per 15 s poll.
const MAX_PROBES_PER_READ = 64

// Per-session snapshot feeds. Polls read by explicit index, since Bee's feed search under-reports when loaded.
export class DocFeed implements IDocFeed {
  private readonly bee: Bee
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private readonly probe = new FeedProbe()
  /** Newest index known to exist in each feed, by topic and owner, where the next catch-up resumes probing. */
  private readonly knownTails = new Map<string, bigint>()

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

  // Every entry is a whole snapshot, so only the newest counts: one-chunk probes find it, and only it is downloaded.
  async readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null> {
    const feedKey = `${topic.toHex()}:${owner}`
    let tail = this.knownTails.get(feedKey)

    // Bee's head lookup only seeds a feed met for the first time: on every poll its probes would burn the next indices.
    if (tail === undefined) {
      tail = (await this.latestIndex(topic, owner)) ?? -1n
    }

    const from = tail < fromIndex ? fromIndex : tail + 1n
    const reader = this.bee.soc.makeReader(owner)
    const { latest, next } = await drainFeed(
      index => this.probeIndex(reader, topic, index),
      from,
      owner,
      this.probe,
      `${TAG} ${owner.slice(0, 8)}…`,
      undefined,
      MAX_PROBES_PER_READ,
    )

    if (latest !== null) tail = latest

    // Probes used up with entries still coming: far behind, so seed again from the head.
    if (next - from >= BigInt(MAX_PROBES_PER_READ)) {
      const head = await this.latestIndex(topic, owner)

      if (head !== null && head > tail) tail = head
    }

    this.knownTails.set(feedKey, tail)

    if (tail < fromIndex || !this.probe.ready(owner, tail)) return null

    const result = await this.readIndex(topic, owner, tail)

    if (result.status === 'ok') {
      this.probe.clear(owner, tail)

      return result.payload
    }

    this.probe.defer(owner, tail, result.status)

    if (result.status === 'failed') {
      this.errorHandler.handleError(result.error, `${TAG}.readLatestFrom(${owner.slice(0, 8)}…)`)
    }

    return null
  }

  async resolveTail(topic: Topic, owner: string): Promise<bigint> {
    return await resolveFeedTail(
      () => this.latestIndex(topic, owner),
      index => this.readIndex(topic, owner, index),
      `${TAG}(${owner.slice(0, 8)}…)`,
    )
  }

  // Bee's head lookup; `null` on a miss or error, and the forward walk takes over.
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

  // Whether the update at `index` exists, from its single chunk; the snapshot it wraps is not downloaded.
  private async probeIndex(reader: SOCReader, topic: Topic, index: bigint): Promise<FeedRead<bigint>> {
    try {
      await reader.download(new Identifier(Bytes.keccak256(Bytes.concat(topic, FeedIndex.fromBigInt(index)))))

      return { status: 'ok', payload: index }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
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
