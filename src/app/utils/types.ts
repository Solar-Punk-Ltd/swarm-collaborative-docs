export enum Transport {
  WEBRTC = 'webrtc',
  WAKU = 'waku',
  SWARM_PUBSUB = 'swarm-pubsub',
}

export enum DocType {
  Code = 'code',
  Document = 'document',
}

export interface SessionOpts {
  username: string
  topic: string
  transport: Transport
  docType: DocType
  signalingUrl?: string
  stunUrl?: string
  wakuAddress?: string
  brokerPeer?: string
}

export interface Session {
  username: string
  privKey: string
  pubKey: string
  topic: string
  docType: DocType
  transport: Transport
  signalingUrl?: string
  stunUrl?: string
  wakuAddress?: string
  brokerPeer?: string
}

export const TRANSPORT_LABELS: Record<Transport, string> = {
  [Transport.WEBRTC]: 'WebRTC',
  [Transport.WAKU]: 'Waku',
  [Transport.SWARM_PUBSUB]: 'Swarm Pubsub',
}

export const DOCTYPE_LABELS: Record<DocType, string> = {
  [DocType.Code]: 'Code',
  [DocType.Document]: 'Document',
}

export enum WebrtcMode {
  SIGNALING_SERVER = 'signaling-server',
  SWARM_SIGNAL_FEED = 'swarm-singal-feed',
}

export interface AwarenessState {
  address: string
  username: string
  cursor: { anchor: number; head: number } | null
}
