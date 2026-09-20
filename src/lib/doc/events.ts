/**
 * Event names emitted by `SwarmDoc.getEmitter()`.
 */
export const DOC_EVENTS = {
  /** Fired after every remote update is applied to the Yjs doc. Payload: `Y.Doc`. */
  DOC_UPDATED: 'docUpdated',
  /** Fired on stamp validation failure or publish error. Payload: `Error`. */
  DOC_ERROR: 'docError',
  /**
   * Fired once initialisation finishes: stamps validated, own snapshot restored and the member
   * list merged. The document exists and is addressable from this point.
   *
   * It may still be **incomplete**: peers found during init hold state of their own, and a feed
   * that was not readable yet delivers it seconds later. Gate an editor on `DOC_SYNC_STATE` as
   * well, or the first edits are made against a fragment of the document and merge into a version
   * the author never saw. Payload: `{ memberCount: number }`.
   */
  DOC_READY: 'docReady',
  /**
   * Fired while the document is still being assembled from the peers known at startup, and once
   * more when it is done. Payload: `{ synced: boolean; pending: number }`.
   *
   * `synced` latches: it turns true when every peer found during init has delivered state, or when
   * the wait for the stragglers times out, and never goes back to false — a peer arriving later
   * must not disable an editor somebody is typing in. `pending` keeps counting peers that still
   * owe state, so an app can say so without blocking on it.
   */
  DOC_SYNC_STATE: 'docSyncState',
  /**
   * Fired when the transport's own channel is usable. Says nothing about peers being present —
   * gate an editor on `DOC_READY`, and a presence indicator on `PEERS_CONNECTED`. Payload: `true`.
   */
  TRANSPORT_READY: 'transportReady',
  /** Fired when the peer list changes. Payload: `ReadonlyMap<string, MemberEntry>` keyed by session address. */
  MEMBERS_UPDATED: 'membersUpdated',
  /** Fired when at least one remote peer is connected. Never fires for a lone peer. Payload: `true`. */
  PEERS_CONNECTED: 'peersConnected',
  /**
   * Fired when a peer's cursor position changes.
   * Payload: `{ address: string; identity: string; username: string; cursor: CursorPosition }`.
   * `cursor: null` means the peer deselected or disconnected.
   */
  AWARENESS_UPDATED: 'awarenessUpdated',
  /** Fired when any peer's connection state changes. Payload: `ReadonlyMap<string, PeerConnectionState>`. */
  PEER_STATE_UPDATED: 'peerStateUpdated',
  /** Fired when local edits are queued but not yet written to Swarm. Payload: `true`. */
  WRITE_PENDING: 'writePending',
  /** Fired when every queued local edit has been written to Swarm. Payload: `true`. */
  WRITE_DONE: 'writeDone',
}
