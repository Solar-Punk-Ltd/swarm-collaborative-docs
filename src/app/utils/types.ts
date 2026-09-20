import { CursorPosition } from 'lib'

export enum Transport {
  SWARM_RTC = 'swarm-rtc',
  SIGNALING_SERVER = 'signaling-server',
}

export enum DocType {
  Code = 'code',
  Document = 'document',
}

export interface SessionOpts {
  username: string
  transport: Transport
  docType: DocType
  stunUrl: string
  signalingUrl?: string
}

export interface Session {
  username: string
  privKey: string
  pubKey: string
  docType: DocType
  transport: Transport
  stunUrl: string
  signalingUrl?: string
}

export const TRANSPORT_LABELS: Record<Transport, string> = {
  [Transport.SWARM_RTC]: 'Swarm-signalled WebRTC',
  [Transport.SIGNALING_SERVER]: 'Signaling server',
}

export const DOCTYPE_LABELS: Record<DocType, string> = {
  [DocType.Code]: 'Code',
  [DocType.Document]: 'Document',
}

export interface AwarenessState {
  address: string
  identity: string
  username: string
  cursor: CursorPosition
}
