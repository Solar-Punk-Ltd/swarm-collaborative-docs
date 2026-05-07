/** Fields shared by every notification payload variant. */
interface BasePayload {
  /** Protocol version string (e.g. `"v1"`). Used to detect incompatible clients. */
  v: string
  /** Swarm feed topic identifier for the collaborative document. */
  topic: string
  /** Ethereum address of the publishing peer (hex, no 0x prefix). */
  author: string
  /** Nickname of the publishing peer. */
  username: string
}

/**
 * Peer-join announcement. Signals that a new peer has joined the session and
 * that receivers should fetch the peer's latest snapshot from their Swarm feed.
 * Carries no document data.
 */
export interface JoinPayload extends BasePayload {
  type: 'join'
}

/**
 * Incremental document update from a peer. Contains the Swarm doc-feed index
 * written by the author and an optional base64 Yjs delta for fast-path application.
 * The delta MUST be accompanied by a secp256k1 signature; unsigned deltas are dropped.
 */
export interface DocPayload extends BasePayload {
  type: 'doc'
  /** Swarm doc-feed index written by the author for this update. */
  feedIndex: number
  /**
   * Base64-encoded Yjs incremental update for peers already online.
   * Absent when only a snapshot was written (e.g. retry after a missed delta).
   */
  delta?: string
  /**
   * Hex-encoded secp256k1 signature of the raw delta bytes (before base64 encoding).
   * Required when `delta` is present. Receivers MUST verify and drop invalid signatures.
   */
  sig?: string
}

/**
 * Cursor-only awareness update. Sent on a ~500ms timer independent of doc edits.
 * Carries no document data and requires no signature.
 */
export interface CursorPayload extends BasePayload {
  type: 'cursor'
  /**
   * Current cursor position in the shared `Y.Text` (character index offsets).
   * `null` signals the peer has deselected or disconnected.
   */
  cursor: { anchor: number; head: number } | null
}

/** Union of all notification payload variants exchanged between peers. */
export type NotificationPayload = JoinPayload | DocPayload | CursorPayload

/** Callback invoked whenever a notification arrives on the subscribed topic. */
export type NotificationHandler = (payload: NotificationPayload) => void

/**
 * Low-level interface for pluggable notification channels.
 * Used internally by `SwarmFeedNotificationProvider`.
 * Prefer the higher-level `DocTransport` interface for new transports.
 */
export interface NotificationProvider {
  subscribe(topic: string, handler: NotificationHandler): void
  publish(payload: NotificationPayload): void
  unsubscribe(): void
  /** Register a peer address so this provider polls their notification feed. */
  addMember?(address: string): void
}
