import type { Topic } from '@ethersphere/bee-js'

/** Payload at each index of a session's snapshot feed. */
export interface DocFeedRecord {
  /** Protocol version string (e.g. `"v1"`). */
  v: string
  /** Base64-encoded full `Y.Doc` state produced by `Y.encodeStateAsUpdate`. */
  snapshot: string
  /** Unix timestamp (ms) when the snapshot was written. */
  timestamp: number
}

/** A snapshot read back from a feed, paired with its index. */
export interface DocFeedEntry {
  index: bigint
  snapshot: string
  timestamp: number
}

/** Reads and writes the per-session snapshot feeds. Every one is owned by its session's identity. */
export interface IDocFeed {
  /** Reads `owner`'s snapshot at exactly `index`. Returns `null` if that index does not exist. */
  read(topic: Topic, owner: string, index: bigint): Promise<DocFeedEntry | null>

  /** `owner`'s newest snapshot at or after `fromIndex`, or `null` if nothing is readable from there. */
  readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null>

  /** Highest index present in `owner`'s feed, or `-1n` if it holds nothing yet. */
  resolveTail(topic: Topic, owner: string): Promise<bigint>

  /** Writes a snapshot at `index` of this storage owner's feed `topic`. Throws if the write fails. */
  write(topic: Topic, index: bigint, snapshot: string): Promise<void>
}
