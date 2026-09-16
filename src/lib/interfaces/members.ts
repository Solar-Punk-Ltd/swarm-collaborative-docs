/** Live transport connection state for a registered peer. */
export enum PeerConnectionState {
  /** Peer is known from the consensus feed but no live channel is open. */
  Registered = 'registered',
  /** An active data channel (or equivalent) is open with this peer. */
  Connected = 'connected',
}

/**
 * One editing session of one identity.
 *
 * Keyed in the member map by its **session address**, which is what addresses that session's
 * Swarm feeds. `identity` is the address of the underlying user, shared by all of their
 * sessions — group by it to show one row per person.
 */
export interface MemberEntry {
  /** Display name of the user. */
  username: string
  /** Identity address of the user (hex, no 0x prefix). Shared across that user's sessions. */
  identity: string
  /** Session identifier this entry was registered with. */
  sessionId: string
  /** Unix timestamp (ms) the entry was last written or refreshed. */
  lastSeen: number
  /**
   * `false` once the session has shut down. Retired sessions are never dialled, but their
   * snapshot feed is still read — it holds the only copy of what that session wrote.
   */
  live: boolean
}

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
  /** Adds a session to the local peer set. Returns `true` if newly added, `false` if already present. */
  register(address: string, entry: MemberEntry): boolean

  /** Returns `true` if `address` is in the local peer set. */
  has(address: string): boolean

  /** Returns the entry for `address`, or `undefined` if it is not registered. */
  get(address: string): MemberEntry | undefined

  /** Returns a shallow copy of the registered peer map, keyed by session address. */
  all(): ReadonlyMap<string, MemberEntry>

  /** Returns the last feed index applied from this peer, or `-1n` if none yet. */
  lastIndex(address: string): bigint

  /** Records the latest applied Swarm feed index for `address`. */
  setIndex(address: string, index: bigint): void

  /** Updates the live connection state for `address`. */
  setConnectionState(address: string, state: PeerConnectionState): void

  /** Returns a shallow copy of the connection-state map. Absent entries default to `Registered`. */
  allConnectionStates(): ReadonlyMap<string, PeerConnectionState>

  /** Reads the current member list from the Swarm consensus feed. Returns `null` if the feed does not exist yet. */
  read(): Promise<Map<string, MemberEntry> | null>

  /**
   * Adds `address` to the Swarm consensus member list.
   * Reads back the written index to detect last-write-wins conflicts.
   * Returns the confirmed list, or the optimistic list if verification times out.
   */
  add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>>

  /**
   * Marks `address` as no longer live in the consensus feed, so other peers stop dialling it.
   * Best-effort: a failed write is swallowed, since this runs during shutdown.
   */
  retire(address: string): Promise<void>
}
