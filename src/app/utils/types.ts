export enum Transport {
  WEBRTC = 'webrtc',
  WAKU = 'waku',
  SWARM_PUBSUB = 'swarm-pubsub',
}

export interface Session {
  username: string
  privKey: string
  pubKey: string
  topic: string
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

export enum WebrtcMode {
  SIGNALING_SERVER = 'signaling-server',
  SWARM_SIGNAL_FEED = 'swarm-singal-feed',
}
