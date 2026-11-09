import type { Topic } from '@ethersphere/bee-js'

/** One read from Swarm. `absent` is a clean miss; `failed` is unknown and is never treated as absent. */
export type StorageRead =
  | { status: 'ok'; data: Uint8Array }
  | { status: 'absent' }
  | { status: 'failed'; error: unknown }

/**
 * Where the library reads and writes Swarm. Every feed a session writes is owned by `owner`, so the same code runs
 * whether the page holds the key (a Bee node, `createBeeStorage`) or the browser does (Freedom, `createFreedomStorage`).
 */
export interface SwarmStorage {
  /** Address (hex, no 0x, lowercase) that owns every feed this storage writes: the person's identity in the room. */
  readonly owner: string

  /** Checks that writes can succeed. Calls `onWarn` for soft problems; throws when writes are certain to fail. */
  check(onWarn: (msg: string) => void): Promise<void>

  /** The payload of `owner`'s feed `topic` at exactly `index`. */
  readFeed(topic: Topic, owner: string, index: bigint): Promise<StorageRead>

  /** The newest index the node reports for `owner`'s feed `topic`, or `null`. Readers confirm it forward. */
  feedHead(topic: Topic, owner: string): Promise<bigint | null>

  /** Writes `data` at `index` of this storage's own feed `topic`. Throws if the write fails. */
  writeFeed(topic: Topic, index: bigint, data: Uint8Array): Promise<void>

  /** The payload of the GSOC chunk at `topic`, which anyone who knows the topic can write. At most 4000 bytes. */
  readGsoc(topic: string): Promise<StorageRead>

  /** Writes the GSOC chunk at `topic`, replacing what a node holds there. Throws if the write fails. */
  sendGsoc(topic: string, data: Uint8Array): Promise<void>
}
