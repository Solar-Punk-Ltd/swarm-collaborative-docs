/**
 * Event names emitted by `SwarmDoc.getEmitter()`.
 *
 * ```ts
 * swarmDoc.getEmitter().on(DOC_EVENTS.DOC_UPDATED, (doc: Y.Doc) => ...)
 * swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR,   (err: Error) => ...)
 * swarmDoc.getEmitter().on(DOC_EVENTS.MEMBERS_UPDATED, (members: Map<string, string>) => ...)
 * swarmDoc.getEmitter().on(DOC_EVENTS.PEERS_CONNECTED, (connected: true) => ...)
 * swarmDoc.getEmitter().on(DOC_EVENTS.AWARENESS_UPDATED,
 *   (update: { address: string; username: string; cursor: { anchor: number; head: number } | null }) => ...)
 * ```
 */
export const DOC_EVENTS = {
  /** Fired after every remote update is applied to the Yjs doc. Payload: `Y.Doc`. */
  DOC_UPDATED: 'docUpdated',
  /** Fired on stamp validation failure or publish error. Payload: `Error`. */
  DOC_ERROR: 'docError',
  /** Fired when the peer list changes. Payload: `Map<string, string>` (Ethereum address and username pairs). */
  MEMBERS_UPDATED: 'membersUpdated',
  /** Fired once when the transport has at least one connected peer. Payload: `true`. */
  PEERS_CONNECTED: 'peersConnected',
  /**
   * Fired when a peer's cursor position changes.
   * Payload: `{ address: string; username: string; cursor: { anchor: number; head: number } | null }`.
   * `cursor: null` means the peer deselected or disconnected.
   */
  AWARENESS_UPDATED: 'awarenessUpdated',
}
