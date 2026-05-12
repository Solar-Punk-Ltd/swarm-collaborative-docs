/** Fields shared by every notification payload variant. */
interface BasePayload {
  /** Protocol version string (e.g. `"v1"`). */
  v: string
  /** Swarm feed topic identifier for the collaborative document. */
  topic: string
  /** Ethereum address of the publishing peer (hex, no 0x prefix). */
  author: string
  /** Nickname of the publishing peer. */
  username: string
}

/** Peer-join announcement. Receivers fetch the peer's latest snapshot from their Swarm feed. */
export interface JoinPayload extends BasePayload {
  type: 'join'
}

/**
 * Incremental document update. The delta MUST be accompanied by a secp256k1 signature;
 * unsigned or invalid deltas are dropped by receivers.
 */
export interface DocPayload extends BasePayload {
  type: 'doc'
  /** Swarm doc-feed index written by the author for this update. */
  feedIndex: number
  /** Base64-encoded Yjs incremental update for peers already online. */
  delta?: string
  /** Hex-encoded secp256k1 signature of the raw delta bytes. Required when `delta` is present. */
  sig?: string
}

/** Cursor-only awareness update. Sent on a ~500 ms timer, independent of doc edits. */
export interface CursorPayload extends BasePayload {
  type: 'cursor'
  /** Character index offsets in the shared `Y.Text`. `null` means deselected or disconnected. */
  cursor: { anchor: number; head: number } | null
}

/** Union of all notification payload variants exchanged between peers. */
export type NotificationPayload = JoinPayload | DocPayload | CursorPayload

/** Callback invoked whenever a notification arrives on the subscribed topic. */
export type NotificationHandler = (payload: NotificationPayload) => void
