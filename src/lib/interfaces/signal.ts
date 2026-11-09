/** Kind of WebRTC signal record. */
export enum SignalType {
  /** SDP offer created by the connection initiator. */
  OFFER = 'offer',
  /** SDP answer created by the connection responder. */
  ANSWER = 'answer',
}

/** A single WebRTC signaling record. One offer or answer per peer per session. */
export interface SignalRecord {
  type: SignalType
  /** Session address of the writer. */
  fromAddress: string
  /** Session address of the recipient. */
  toAddress: string
  /** UUID identifying the `RTCPeerConnection` session; correlates offer ↔ answer. */
  sessionId: string
  /** Unix timestamp (ms) when the record was written. Used for staleness checks. */
  timestamp: number
  /** Full SDP string with ICE candidates embedded, written after ICE gathering completes. */
  sdp: string
}

/** Payload at each index of a session's signal feed. */
export interface SignalFeedPayload {
  records: SignalRecord[]
}

/** A session whose signal feed is read: its feed is owned by `identity` and named by `sessionId`. */
export interface SignalPeer {
  /** Session address. */
  address: string
  /** Identity address that owns the session's feeds. */
  identity: string
  /** Session identifier in the feed's topic. */
  sessionId: string
}

/** WebRTC signal records on per-session Swarm feeds, used by the swarm-rtc transport. Writes are serialised. */
export interface ISwarmSignal {
  /** Reads a peer's signal feed. Returns `null` if the feed doesn't exist or has no new data. */
  read(peer: SignalPeer): Promise<SignalFeedPayload | null>

  /** Writes `record`, replacing any earlier one of the same type to the same peer. */
  writeRecord(record: SignalRecord): Promise<void>

  /** Writes an empty payload to own feed, clearing all records from the previous session. */
  clearOwn(): Promise<void>

  /** Stops further writes. Queued work that has not started yet becomes a no-op. */
  stop(): void
}
