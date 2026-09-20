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
 * Everything one principal publishes about a room, written to that principal's announce feed.
 *
 * Each entry replaces the last, so only the newest index matters. `known` is what makes discovery
 * work without a shared feed: announce feeds are addressed per principal, so a reader that learns
 * a principal can derive its feed and read it, and following `known` outward from the room's
 * creator reaches everyone the room has seen.
 */
export interface AnnouncePayload {
  /** Payload format version. */
  v: string
  /** Principal owning this feed. Sessions listed here belong to it. */
  principal: string
  /** This principal's sessions, keyed by session address. */
  sessions: Record<string, MemberEntry>
  /** Principals this writer has seen, including itself. Followed transitively by readers. */
  known: string[]
}

/**
 * One entry of the room's directory feed, naming principals that hold announce feeds.
 *
 * The only feed in a room with more than one writer, and the only one whose older entries still
 * matter: an entry is never rewritten, so readers take the union of all of them and a write that
 * loses a race costs an index rather than anyone's membership.
 */
export interface DirectoryPayload {
  /** Payload format version. */
  v: string
  /** Principals this entry adds to the room. Usually one — the writer's own. */
  principals: string[]
}

/**
 * Manages the set of known peers for a collaborative doc session.
 *
 * Two layers of state:
 * - **Local session** — in-memory set of registered peer addresses and their last known feed index.
 * - **Swarm discovery** — a directory feed listing the room's principals, plus one announce feed
 *   per principal, each with a single writer, holding that principal's sessions.
 *
 * Every signing key here derives from the room secret, so knowing a room's public identifier
 * grants nothing — only an invite link does.
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

  /**
   * Reads every announce feed reachable from the principals known so far, following each payload's
   * `known` list outward. Returns the merged member list, or `null` if nothing was readable.
   */
  read(): Promise<Map<string, MemberEntry> | null>

  /**
   * Publishes `address` as a session of this principal on its own announce feed.
   * Returns the merged member list as it stands after the write.
   */
  add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>>

  /**
   * Marks `address` as no longer live on this principal's announce feed, so other peers stop
   * dialling it. Best-effort: a failed write is swallowed, since this runs during shutdown.
   */
  retire(address: string): Promise<void>
}
