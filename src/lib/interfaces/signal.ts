// A single record in the per-user _signal Swarm feed.
// type='offer'  → this peer created an offer for `toAddress`
// type='answer' → this peer answered an offer from `toAddress`
export interface SignalRecord {
  type: 'offer' | 'answer'
  fromAddress: string // Ethereum address of the writer (redundant with feed key, kept for clarity)
  toAddress: string // Ethereum address of the intended recipient
  sessionId: string // UUID per RTCPeerConnection; used to correlate offer ↔ answer
  timestamp: number
  sdp: string // full SDP with ICE candidates embedded (gathered after icegatheringstatechange='complete')
}

// Raw JSON payload stored in the per-user _signal Swarm feed
export interface SignalFeedPayload {
  records: SignalRecord[]
}
