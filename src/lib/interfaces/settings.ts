import { DocTransportFactory } from './docTransport'

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
    transport: DocTransportFactory
  }
}

export interface UserSettings {
  privateKey: string
  ownAddress: string
  nickname: string
  ownIndex: bigint
}
