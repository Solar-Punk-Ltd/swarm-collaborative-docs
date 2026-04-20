export enum Transport {
  SWARM = 'swarm',
  BROADCAST = 'broadcast',
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
  [Transport.SWARM]: 'Swarm Feed',
  [Transport.BROADCAST]: 'BroadcastChannel',
  [Transport.WEBRTC]: 'WebRTC',
  [Transport.WAKU]: 'Waku',
  [Transport.SWARM_PUBSUB]: 'Swarm Pubsub',
}

export enum WebrtcMode {
  SIGNALING = 'signaling',
  SWARM = 'swarm',
}
