import { Bytes, FeedIndex, Topic } from '@ethersphere/bee-js'

import type { StorageRead, SwarmStorage } from '../interfaces'
import { decode, remove0x } from '../utils/common'

import { splitIntoChunks, TreeChunk } from './chunkTree'
import { gsocCoordinates } from './gsoc'

/** The part of Freedom Browser's `window.swarm` provider this storage uses. */
export interface FreedomSwarmProvider {
  request(args: { method: string; params?: Record<string, unknown> }): Promise<unknown>
}

/** Options for `createFreedomStorage`. */
export interface FreedomStorageOptions {
  /** The provider; defaults to `window.swarm`. */
  provider?: FreedomSwarmProvider
  /** Chunk uploads in flight at once when a write is larger than one chunk. */
  uploadConcurrency?: number
}

const MAX_CHUNK_PAYLOAD = 4096
const DEFAULT_UPLOAD_CONCURRENCY = 4

/**
 * Storage through Freedom Browser's `window.swarm`. Freedom stops pages from reaching a node's API (0.8.7 and later)
 * and signs every write itself with its identity for the site, so the page holds no key. Asks for the connection and
 * feed grants (one prompt each, the first time); the messaging grant is asked on the first member-list write.
 * Freedom's node needs a usable postage batch (its publishing setup) for writes.
 */
export async function createFreedomStorage(options: FreedomStorageOptions = {}): Promise<SwarmStorage> {
  const provider = options.provider ?? (globalThis as { swarm?: FreedomSwarmProvider }).swarm

  if (!provider) throw new Error('window.swarm is not available: open the page in Freedom Browser.')

  await provider.request({ method: 'swarm_requestAccess' })
  const identity = (await provider.request({ method: 'swarm_getSigningIdentity' })) as { owner: string }

  return new FreedomStorage(provider, remove0x(identity.owner), options.uploadConcurrency)
}

interface ProviderError {
  message?: string
  data?: { reason?: string }
}

/** `true` when Freedom reports a clean miss rather than a failure. */
function isMiss(err: unknown): boolean {
  const reason = (err as ProviderError)?.data?.reason

  return reason === 'entry_not_found' || reason === 'feed_empty' || reason === 'chunk_not_found'
}

class FreedomStorage implements SwarmStorage {
  constructor(
    private readonly provider: FreedomSwarmProvider,
    public readonly owner: string,
    private readonly uploadConcurrency = DEFAULT_UPLOAD_CONCURRENCY,
  ) {}

  async check(onWarn: (msg: string) => void): Promise<void> {
    const caps = (await this.call('swarm_getCapabilities')) as { canPublish?: boolean; reason?: string | null }

    if (!caps?.canPublish) {
      onWarn(`Freedom cannot publish yet (${caps?.reason ?? 'unknown reason'}): edits stay in this tab until it can.`)
    }
  }

  async readFeed(topic: Topic, owner: string, index: bigint): Promise<StorageRead> {
    try {
      const entry = (await this.call('swarm_readFeedEntry', {
        topic: remove0x(topic.toHex()),
        owner,
        index: Number(index),
      })) as { data: string }

      return { status: 'ok', data: decode(entry.data) }
    } catch (err) {
      return isMiss(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  async feedHead(topic: Topic, owner: string): Promise<bigint | null> {
    try {
      const entry = (await this.call('swarm_readFeedEntry', { topic: remove0x(topic.toHex()), owner })) as {
        index: number
      }

      return typeof entry?.index === 'number' ? BigInt(entry.index) : null
    } catch {
      return null
    }
  }

  // A payload over one chunk goes up as a chunk tree, the root wrapped in the feed entry with the whole length as
  // its span: the same bytes bee-js writes, so bee-js readers and `swarm_readFeedEntry` both read it back.
  async writeFeed(topic: Topic, index: bigint, data: Uint8Array): Promise<void> {
    const identifier = feedIdentifier(topic, index)

    if (data.length <= MAX_CHUNK_PAYLOAD) {
      await this.call('swarm_writeSingleOwnerChunk', { identifier, data })

      return
    }

    const chunks = splitIntoChunks(data)
    await this.publishChunks(chunks)
    const root = chunks[chunks.length - 1]
    await this.call('swarm_writeSingleOwnerChunk', { identifier, data: root.payload, span: root.span })
  }

  async readGsoc(topic: string): Promise<StorageRead> {
    const { identifier, owner } = await gsocCoordinates(topic)

    try {
      const soc = (await this.call('swarm_readSingleOwnerChunk', {
        owner: remove0x(owner.toHex()),
        identifier: remove0x(identifier.toHex()),
      })) as { data: string }

      return { status: 'ok', data: decode(soc.data) }
    } catch (err) {
      return isMiss(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  // Freedom mines the same key from the topic (see gsoc.ts); only the topic and payload cross.
  async sendGsoc(topic: string, data: Uint8Array): Promise<void> {
    await this.call('swarm_sendGsoc', { topic, data })
  }

  private async publishChunks(chunks: TreeChunk[]): Promise<void> {
    let next = 0
    let failed = false
    const worker = async (): Promise<void> => {
      while (next < chunks.length && !failed) {
        const { payload, span, address } = chunks[next++]
        try {
          const { reference } = (await this.call('swarm_publishChunk', { data: payload, span })) as {
            reference: string
          }

          if (remove0x(reference) !== address) {
            throw new Error(`Freedom stored a chunk at ${reference}, expected ${address}`)
          }
        } catch (err) {
          failed = true
          throw err
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(this.uploadConcurrency, chunks.length) }, worker))
  }

  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.provider.request({ method, params })
  }
}

/** A feed entry's identifier, keccak256(topic ‖ index as 8 bytes big-endian), as bee-js computes it. */
function feedIdentifier(topic: Topic, index: bigint): string {
  const t = topic.toUint8Array()
  const i = FeedIndex.fromBigInt(index).toUint8Array()
  const joined = new Uint8Array(t.length + i.length)
  joined.set(t)
  joined.set(i, t.length)

  return remove0x(Bytes.keccak256(joined).toHex())
}
