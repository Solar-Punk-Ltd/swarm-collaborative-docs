export enum Transport {
  SWARM = 'swarm',
  BROADCAST = 'broadcast',
  WEBRTC = 'webrtc',
  WAKU = 'waku',
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
}

export const TRANSPORT_LABELS: Record<Transport, string> = {
  [Transport.SWARM]: 'Swarm Feed',
  [Transport.BROADCAST]: 'BroadcastChannel',
  [Transport.WEBRTC]: 'WebRTC',
  [Transport.WAKU]: 'Waku',
}

export enum WebrtcMode {
  SIGNALING = 'signaling',
  SWARM = 'swarm',
}
