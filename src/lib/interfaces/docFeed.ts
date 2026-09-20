import type { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

/** JSON payload stored at each index of a per-user document snapshot feed. */
export interface DocFeedRecord {
  /** Protocol version string (e.g. `"v1"`). */
  v: string
  /** Base64-encoded full `Y.Doc` state produced by `Y.encodeStateAsUpdate`. */
  snapshot: string
  /** Unix timestamp (ms) when the snapshot was written. */
  timestamp: number
}

/** A snapshot read back from a feed, paired with the index Bee resolved it at. */
export interface DocFeedEntry {
  index: bigint
  snapshot: string
  timestamp: number
}

/** Reads and writes the per-user document snapshot feeds backing a collaborative session. */
export interface IDocFeed {
  /** Reads `owner`'s snapshot at exactly `index`. Returns `null` if that index does not exist. */
  read(topic: Topic, owner: string, index: FeedIndex): Promise<DocFeedEntry | null>

  /**
   * Returns `owner`'s newest snapshot at or after `fromIndex`, walking indices forward.
   * Returns `null` when nothing is readable from there.
   */
  readLatestFrom(topic: Topic, owner: string, fromIndex: bigint): Promise<DocFeedEntry | null>

  /** Highest index present in `owner`'s feed, or `-1n` if it holds nothing yet. */
  resolveTail(topic: Topic, owner: string): Promise<bigint>

  /** Writes a snapshot to `signer`'s own feed at `index`. Throws if the write fails. */
  write(topic: Topic, signer: PrivateKey, index: FeedIndex, snapshot: string): Promise<void>
}
