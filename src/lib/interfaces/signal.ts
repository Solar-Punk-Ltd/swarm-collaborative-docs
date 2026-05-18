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

/**
 * Reads and writes WebRTC signaling records to a per-user Swarm feed.
 *
 * Writes are serialised to prevent index conflicts when `clearOwn` and `writeRecord` run concurrently.
 * Used exclusively by `SwarmRtcTransport`.
 */
export interface ISwarmSignal {
  /** Reads the signal feed for any peer. Returns `null` if the feed doesn't exist or has no new data. */
  read(peerAddress: string): Promise<SignalFeedPayload | null>

  /**
   * Appends or replaces a signal record in own feed.
   * Deduplication key: `type + toAddress` — only one active offer/answer per peer.
   */
  writeRecord(record: SignalRecord): Promise<void>

  /** Writes an empty payload to own feed, clearing all records from the previous session. */
  clearOwn(): Promise<void>
}
