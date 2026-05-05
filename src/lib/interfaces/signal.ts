/** WebRTC signaling record type stored in the per-user `_signal` Swarm feed. */
export enum SignalType {
  /** SDP offer created by the connection initiator. */
  OFFER = 'offer',
  /** SDP answer created by the connection responder. */
  ANSWER = 'answer',
}

/** A single WebRTC signaling record. One offer or answer per peer per session. */
export interface SignalRecord {
  type: SignalType
  /** Ethereum address of the record writer. */
  fromAddress: string
  /** Ethereum address of the intended recipient. */
  toAddress: string
  /** UUID identifying the `RTCPeerConnection` session; correlates offer ↔ answer. */
  sessionId: string
  /** Unix timestamp (ms) when the record was written. Used for staleness checks. */
  timestamp: number
  /** Full SDP string with ICE candidates embedded, written after ICE gathering completes. */
  sdp: string
}

/** JSON payload stored at each index of the per-user `_signal` Swarm feed. */
export interface SignalFeedPayload {
  records: SignalRecord[]
}
