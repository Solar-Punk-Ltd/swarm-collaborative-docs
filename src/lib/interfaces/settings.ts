import { NotificationProvider } from './notification'

export interface DocSettings {
  user: {
    privateKey: string
    nickname: string
  }
  infra: {
    beeUrl: string
    stamp?: string
    mutableStamp?: string // postage batch with immutableFlag=false, used for snapshot writes
    topic: string
    members?: string[]
    signalingUrls?: string[] // y-webrtc signaling server(s), e.g. ['ws://localhost:4444']
    iceServers?: RTCIceServer[] // custom STUN/TURN servers; RTCIceServer is a DOM type, no import needed
  }
  notificationProvider?: NotificationProvider // required for Swarm/Broadcast transports; omit when using y-webrtc
}

export interface UserSettings {
  privateKey: string
  ownAddress: string
  nickname: string
  ownIndex: bigint
}
