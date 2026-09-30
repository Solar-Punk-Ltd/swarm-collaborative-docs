/** Event names emitted by `SwarmDoc.getEmitter()`. */
export const DOC_EVENTS = {
  /** Fired after every remote update is applied to the Yjs doc. Payload: `Y.Doc`. */
  DOC_UPDATED: 'docUpdated',
  /** Fired on stamp validation failure or publish error. Payload: `Error`. */
  DOC_ERROR: 'docError',
  /**
   * Init finished: stamp valid, own snapshot restored, members read. Peers' state may still be missing, so gate
   * editing on `DOC_SYNC_STATE` too. Payload: `{ memberCount: number }`.
   */
  DOC_READY: 'docReady',
  /**
   * Progress of assembling state from the peers known at startup. `synced` turns true once they all delivered or the
   * wait timed out, and never goes back. `pending` counts peers still owing state. Payload: `{ synced; pending }`.
   */
  DOC_SYNC_STATE: 'docSyncState',
  /** Fired when the transport's own channel is usable; says nothing about peers. Payload: `true`. */
  TRANSPORT_READY: 'transportReady',
  /** Fired when the peer list changes. Payload: `ReadonlyMap<string, MemberEntry>` keyed by session address. */
  MEMBERS_UPDATED: 'membersUpdated',
  /** Fired when at least one remote peer is connected. Never fires for a lone peer. Payload: `true`. */
  PEERS_CONNECTED: 'peersConnected',
  /** A peer's cursor changed; `cursor: null` when it left. Payload: `{ address; identity; username; cursor }`. */
  AWARENESS_UPDATED: 'awarenessUpdated',
  /** Fired when any peer's connection state changes. Payload: `ReadonlyMap<string, PeerConnectionState>`. */
  PEER_STATE_UPDATED: 'peerStateUpdated',
  /** Fired when local edits are queued but not yet written to Swarm. Payload: `true`. */
  WRITE_PENDING: 'writePending',
  /** Fired when every queued local edit has been written to Swarm. Payload: `true`. */
  WRITE_DONE: 'writeDone',
}
