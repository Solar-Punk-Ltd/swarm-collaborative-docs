import { Topic } from '@ethersphere/bee-js'

import { ISwarmSignal, SignalFeedPayload, SignalPeer, SignalRecord, StorageRead, SwarmStorage } from '../interfaces'
import { SIGNAL_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'SwarmSignal'
// Short: a peer's next signal index holds the offer or answer being waited for.
const SIGNAL_PROBE_BACKOFF_MS = [2_000, 4_000, 8_000]

/** Signal feed topic of one session: `<docFeedId>_signal:<sessionId>`, owned by that session's identity. */
export function signalTopic(docFeedId: string, sessionId: string): Topic {
  return Topic.fromString(`${docFeedId}${SIGNAL_FEED_SUFFIX}:${sessionId}`)
}

function decode(read: StorageRead): FeedRead<SignalFeedPayload> {
  if (read.status !== 'ok') return read

  try {
    const payload = JSON.parse(new TextDecoder().decode(read.data)) as SignalFeedPayload

    return Array.isArray(payload?.records) ? { status: 'ok', payload } : { status: 'absent' }
  } catch (err) {
    return { status: 'failed', error: err }
  }
}

export class SwarmSignal implements ISwarmSignal {
  private readonly storage: SwarmStorage
  private readonly docFeedId: string
  private readonly ownTopic: Topic
  private currentIndex: bigint = -1n
  private ownIndexResolved = false
  private stopped = false
  private readonly peerNextIndexes: Map<string, bigint> = new Map()
  private readonly probe = new FeedProbe(SIGNAL_PROBE_BACKOFF_MS)
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(docFeedId: string, storage: SwarmStorage, ownSessionId: string) {
    this.docFeedId = docFeedId
    this.storage = storage
    this.ownTopic = signalTopic(docFeedId, ownSessionId)
  }

  // Always by explicit index: Bee's feed search delayed offer/answer discovery.
  async read(peer: SignalPeer): Promise<SignalFeedPayload | null> {
    const topic = signalTopic(this.docFeedId, peer.sessionId)
    const key = `${peer.identity}:${peer.sessionId}`
    const { latest, next } = await drainFeed(
      index => this.readIndex(topic, peer.identity, index),
      this.peerNextIndexes.get(key) ?? 0n,
      key,
      this.probe,
      `${TAG} read(${peer.address.slice(0, 8)}…)`,
    )

    this.peerNextIndexes.set(key, next)

    return latest
  }

  private async readIndex(topic: Topic, owner: string, index: bigint): Promise<FeedRead<SignalFeedPayload>> {
    return decode(await this.storage.readFeed(topic, owner, index))
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
    // We are the only writer, so the tail is found once and then tracked in memory.
    if (!this.ownIndexResolved) {
      this.currentIndex = await this.resolveOwnTail()
      this.ownIndexResolved = true
      this.logger.debug(`${TAG} own feed tail resolved at index ${this.currentIndex}`)
    }

    if (this.currentIndex < 0n) {
      return { records: [] }
    }

    const result = await this.readIndex(this.ownTopic, this.storage.owner, this.currentIndex)

    return result.status === 'ok' ? result.payload : { records: [] }
  }

  // An empty head lookup is trusted: confirming it would probe index 0, which our first record is about to use.
  private async resolveOwnTail(): Promise<bigint> {
    const head = await this.storage.feedHead(this.ownTopic, this.storage.owner)

    if (head === null) {
      return -1n
    }

    return await resolveFeedTail(
      () => Promise.resolve(head),
      index => this.readIndex(this.ownTopic, this.storage.owner, index),
      TAG,
    )
  }

  private async writePayload(payload: SignalFeedPayload): Promise<void> {
    const nextIndex = this.currentIndex + 1n

    // Claimed before the upload and kept on failure: a failed write may still have stored its chunk.
    this.currentIndex = nextIndex

    try {
      await this.storage.writeFeed(this.ownTopic, nextIndex, new TextEncoder().encode(JSON.stringify(payload)))
      this.logger.debug(`${TAG} writePayload ✓ index: ${nextIndex}`)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.writePayload(index ${nextIndex})`)
    }
  }
}
