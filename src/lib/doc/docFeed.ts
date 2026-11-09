import { Bytes, Topic } from '@ethersphere/bee-js'

import { DocFeedEntry, DocFeedRecord, IDocFeed, StorageRead, SwarmStorage } from '../interfaces'
import { API_VERSION } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'

const TAG = 'DocFeed'

// Per-session snapshot feeds, owned by the session's identity. Polls read by explicit index, since Bee's feed search
// under-reports when loaded.
export class DocFeed implements IDocFeed {
  private readonly storage: SwarmStorage
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly probe = new FeedProbe()

  constructor(storage: SwarmStorage) {
    this.storage = storage
  }

  async read(topic: Topic, owner: string, index: bigint): Promise<DocFeedEntry | null> {
    const result = await this.readIndex(topic, owner, index)

    if (result.status === 'failed') {
      this.errorHandler.handleError(result.error, `${TAG}.read(${owner.slice(0, 8)}…)`)
    }

    return result.status === 'ok' ? result.payload : null
  }

  async readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null> {
    const { latest } = await drainFeed(
      index => this.readIndex(topic, owner, index),
      fromIndex,
      probeKey(topic, owner),
      this.probe,
      `${TAG} ${owner.slice(0, 8)}…`,
    )

    return latest
  }

  async resolveTail(topic: Topic, owner: string): Promise<bigint> {
    return await resolveFeedTail(
      () => this.storage.feedHead(topic, owner),
      index => this.readIndex(topic, owner, index),
      `${TAG}(${owner.slice(0, 8)}…)`,
    )
  }

  private async readIndex(topic: Topic, owner: string, index: bigint): Promise<FeedRead<DocFeedEntry>> {
    return parseRecord(await this.storage.readFeed(topic, owner, index), index)
  }

  async write(topic: Topic, index: bigint, snapshot: string): Promise<void> {
    const record: DocFeedRecord = { v: API_VERSION, snapshot, timestamp: Date.now() }

    await this.storage.writeFeed(topic, index, Bytes.fromUtf8(JSON.stringify(record)).toUint8Array())
  }
}

// One identity owns several sessions' feeds, so the probe is keyed by feed, not by owner alone.
function probeKey(topic: Topic, owner: string): string {
  return `${owner}:${topic.toHex()}`
}

function parseRecord(read: StorageRead, index: bigint): FeedRead<DocFeedEntry> {
  if (read.status !== 'ok') return read

  try {
    const record = JSON.parse(new TextDecoder().decode(read.data)) as DocFeedRecord

    if (!record?.snapshot) return { status: 'absent' }

    return { status: 'ok', payload: { index, snapshot: record.snapshot, timestamp: record.timestamp } }
  } catch (err) {
    return { status: 'failed', error: err }
  }
}
