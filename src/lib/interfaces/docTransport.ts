import type { PrivateKey } from '@ethersphere/bee-js'
import * as Y from 'yjs'

import type { NotificationHandler, NotificationPayload } from './notification'

export interface DocTransport {
  start(): void
  stop(): void
  subscribe(topic: string, handler: NotificationHandler): void
  publish(payload: NotificationPayload): void
  connectToPeer(address: string): void
  isRemoteOrigin(origin: unknown): boolean
}

export interface DocTransportDeps {
  doc: Y.Doc
  emitter: { emit(event: string, ...args: unknown[]): void }
  members: {
    all(): string[]
    has(address: string): boolean
    lastIndex(address: string): bigint
    setIndex(address: string, index: bigint): void
  }
  ownAddress: string
  nickname: string
  /** Called when the transport discovers a new peer (e.g. via y-webrtc awareness). */
  onPeerDiscovered: (address: string) => void
  // Swarm-specific (YWebrtcTransport ignores these):
  docFeedId: string
  beeApiUrl: string
  signer: PrivateKey
  mutableStampId: string
}

export type DocTransportFactory = (deps: DocTransportDeps) => DocTransport
