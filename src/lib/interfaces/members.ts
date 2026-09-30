/** Live transport connection state for a registered peer. */
export enum PeerConnectionState {
  /** Known from Swarm, but no live channel is open. */
  Registered = 'registered',
  /** An active data channel (or equivalent) is open with this peer. */
  Connected = 'connected',
}

/** One editing session, keyed by session address. Group by `identity` for one row per person. */
export interface MemberEntry {
  /** Display name of the user. */
  username: string
  /** Identity address of the user (hex, no 0x prefix). Shared across that user's sessions. */
  identity: string
  /** Session identifier this entry was registered with. */
  sessionId: string
  /** Unix timestamp (ms) the entry was last written or refreshed. */
  lastSeen: number
  /** `false` once the session shut down. Its snapshot feed is still read: it holds what that session wrote. */
  live: boolean
}

/** An identity's announce feed entry: its sessions and the identities it knows. Only the newest counts. */
export interface AnnouncePayload {
  /** Payload format version. */
  v: string
  /** Identity owning this feed. */
  identity: string
  /** This identity's sessions, keyed by session address. */
  sessions: Record<string, MemberEntry>
  /** Identities this writer has seen, including itself. Followed transitively by readers. */
  known: string[]
}

/** An entry of the append-only directory feed, the one feed every member writes. Readers take the union. */
export interface DirectoryPayload {
  /** Payload format version. */
  v: string
  /** Identities this entry adds to the room. Usually one — the writer's own. */
  identities: string[]
}

/** A room's members: the local peer set, and discovery through the directory and announce feeds. */
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

  /** Reads the directory and every reachable announce feed; the merged members, or `null` if nothing read. */
  read(): Promise<Map<string, MemberEntry> | null>

  /** Publishes `address` as a session of this identity and returns the merged members. */
  add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>>

  /** Marks `address` as no longer live. Best effort, since it runs during shutdown. */
  retire(address: string): Promise<void>
}
