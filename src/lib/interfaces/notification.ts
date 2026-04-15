/** Opaque payload exchanged between peers via the notification channel. */
export interface NotificationPayload {
  /** Protocol version string (e.g. `"v1"`). Used to detect incompatible clients. */
  v: string
  /** Swarm feed topic identifier for the collaborative document. */
  topic: string
  /** Ethereum address of the publishing peer (hex, no 0x prefix). */
  author: string
  /**
   * Swarm doc-feed index written by the author.
   * Set to `JOIN_FEED_INDEX` (-1) to signal a peer join event (no doc update).
   */
  feedIndex: number
  /**
   * Base64-encoded Yjs incremental update (delta) for peers already online.
   * Absent on join notifications or when a snapshot-only write occurred.
   */
  delta?: string
}

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
