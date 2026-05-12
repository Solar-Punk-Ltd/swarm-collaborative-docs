/**
 * Manages the set of known peers for a collaborative doc session.
 *
 * Two layers of state:
 * - **Local session** — in-memory set of registered peer addresses and their last known feed index.
 * - **Swarm consensus** — append-only feed written by all peers, providing persistent discovery
 *   so late-joining peers can find each other without out-of-band key sharing.
 *
 * The consensus signer is derived deterministically from the room topic,
 * so any peer who knows the topic can read and write the member list.
 * Last-write-wins; simultaneous join conflicts are acceptable.
 */
export interface IMembers {
  /** Adds `address` to the local peer set. Returns `true` if newly added, `false` if already present. */
  register(address: string, username: string): boolean

  /** Returns `true` if `address` is in the local peer set. */
  has(address: string): boolean

  /** Returns a shallow copy of the registered peer map. */
  all(): ReadonlyMap<string, string>

  /** Returns the last feed index applied from this peer, or `-1n` if none yet. */
  lastIndex(address: string): bigint

  /** Records the latest applied Swarm feed index for `address`. */
  setIndex(address: string, index: bigint): void

  /** Reads the current member list from the Swarm consensus feed. Returns `null` if the feed does not exist yet. */
  read(): Promise<Map<string, string> | null>

  /**
   * Adds `address` to the Swarm consensus member list.
   * Reads back the written index to detect last-write-wins conflicts.
   * Returns the confirmed list, or the optimistic list if verification times out.
   */
  add(address: string, username: string): Promise<Map<string, string>>
}
