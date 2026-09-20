import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { ISwarmSignal, SignalFeedPayload, SignalRecord } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { DEFERRED_FEED_UPLOAD, SIGNAL_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'SwarmSignal'
/*
 * A peer's next signal index is the one carrying the offer or answer we are waiting for, so the
 * cost of asking too often is a wasted request while the cost of asking too rarely is a handshake
 * that expires before it is read. Kept close to the poll interval for that reason.
 */
const SIGNAL_PROBE_BACKOFF_MS = [2_000, 4_000, 8_000]
// TODO: why is this no imported FeedReader from bee-js?
/*
 * Structural, so it survives bee-js accessor churn. Peer reads are always by explicit index: an
 * unindexed download runs Bee's feed search, whose probes give up after one second each and count
 * a timeout as a miss, which delayed offer/answer discovery by 18–34 s. Signal feeds are
 * append-only from index 0, so the index is always known and every such read is a direct chunk
 * lookup. The unindexed form is used only to seed a tail resolution, which confirms it forward.
 */
interface IndexedFeedReader {
  downloadPayload(options?: { index: FeedIndex }): Promise<{ payload: { toUtf8(): string }; feedIndex: FeedIndex }>
}

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

  private async readIndex(reader: IndexedFeedReader, index: bigint): Promise<FeedRead<SignalFeedPayload>> {
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

  /*
   * Writes are serialised: each one reads the tail the previous one produced, so two in flight
   * would both resolve the same index. The chain is kept settled — a rejection left on it would
   * silently skip every write queued afterwards — and a tail that could not be resolved leaves
   * `ownIndexResolved` false, so the next write retries the resolution rather than guessing.
   */
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

  /*
   * A head lookup that finds nothing is taken at its word here, where every other feed confirms it
   * forward. The confirmation would read index 0 — the address this session's first signal record
   * is about to occupy — and a miss on it takes one of the node's retrieval peers out of play for
   * a minute, on the one chunk the peer waiting for our offer or answer is polling. The forward
   * walk exists to catch a head Bee under-reports on a loaded node; this feed's chunks were
   * uploaded to this node and answer from its own store, so a lookup that returns nothing is
   * reporting an empty feed rather than a slow one, and it already probed index 0 to say so.
   */
  private async resolveOwnTail(reader: IndexedFeedReader): Promise<bigint> {
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

  // Bee's own feed lookup. A miss means an empty feed; an error means the lookup itself is
  // unavailable, and the forward walk from index 0 answers the question without it.
  private async latestIndex(reader: IndexedFeedReader): Promise<bigint | null> {
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

    // Claim the index before uploading and keep it claimed if the upload throws: a failed write may
    // still have stored its chunk, and reusing the index would put a second chunk at that address.
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
