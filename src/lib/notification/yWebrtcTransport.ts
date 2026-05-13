import { WebrtcProvider } from 'y-webrtc'

import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { remove0x } from '../utils/common'
import { API_VERSION } from '../utils/constants'
import { Logger } from '../utils/logger'

const TAG = 'YWebrtcTransport'

class YWebrtcTransport implements DocTransport {
  private logger = Logger.getInstance()
  private provider: WebrtcProvider | null = null
  private clientIdToAddress = new Map<number, string>()
  private handler: NotificationHandler | null = null

  constructor(
    private readonly signalingUrl: string,
    private readonly iceServers: RTCIceServer[] | undefined,
    private readonly deps: DocTransportDeps,
  ) {}

  start(): void {
    const room = this.deps.docFeedId

    this.provider = new WebrtcProvider(room, this.deps.doc, {
      signaling: [this.signalingUrl],
      peerOpts: this.iceServers ? { config: { iceServers: this.iceServers } } : undefined,
    })

    this.provider.awareness.setLocalStateField('user', {
      address: this.deps.ownAddress,
      nickname: this.deps.nickname,
    })

    this.provider.awareness.on(
      'change',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if (!this.provider) return

        const states = this.provider.awareness.getStates()

        for (const clientId of [...added, ...updated]) {
          const isSelf = clientId === this.provider.awareness.clientID

          if (!isSelf) {
            const state = states.get(clientId) as
              | {
                  user?: { address?: string; nickname?: string }
                  cursor?: { anchor: number; head: number } | null
                }
              | undefined

            const address = state?.user?.address ? remove0x(state.user.address.toLowerCase()) : null

            if (address && address !== this.deps.ownAddress) {
              if (!this.deps.members.has(address)) {
                this.logger.log(`${TAG} awareness: new peer ${address.slice(0, 8)}…`)
                this.deps.onPeerDiscovered(address, state?.user?.nickname ?? 'unknown')
                this.clientIdToAddress.set(clientId, address)
              }

              if (this.handler && state) {
                this.handler({
                  type: 'cursor',
                  v: API_VERSION,
                  topic: this.deps.docFeedId,
                  author: address,
                  username: state.user?.nickname ?? address.slice(0, 8),
                  cursor: state.cursor ?? null,
                })
              }
            }
          }
        }

        for (const clientId of removed) {
          const address = this.getAddressForClientId(clientId)

          if (address && this.handler) {
            this.handler({
              type: 'cursor',
              v: API_VERSION,
              topic: this.deps.docFeedId,
              author: address,
              username: '',
              cursor: null,
            })
          }
        }
      },
    )

    this.logger.log(`${TAG} started, room=${room}, signalingUrl=${this.signalingUrl}`)
  }

  stop(): void {
    this.provider?.destroy()
    this.provider = null
  }

  connectToPeer(_address: string): void {}

  subscribe(_topic: string, handler: NotificationHandler): void {
    this.handler = handler
  }

  // 'doc' and 'join' are handled by y-webrtc internally — only cursor needs routing.
  publish(payload: NotificationPayload): void {
    if (payload.type !== 'cursor' || !this.provider) {
      return
    }

    this.provider.awareness.setLocalStateField('cursor', payload.cursor)
  }

  isRemoteOrigin(origin: unknown): boolean {
    return this.provider !== null && origin === this.provider
  }

  private getAddressForClientId(clientId: number): string | null {
    return this.clientIdToAddress.get(clientId) ?? null
  }
}

/**
 * Creates a `DocTransportFactory` using y-webrtc for real-time peer-to-peer sync.
 *
 * Establishes WebRTC data channels via a WebSocket signaling server. Peer discovery
 * is automatic via the y-webrtc `awareness` protocol — no explicit `connectToPeer`
 * calls are needed. New peers are surfaced via `deps.onPeerDiscovered`, triggering a
 * Swarm snapshot fetch for any history written while the peer was offline.
 *
 * `subscribe` and `publish` are no-ops — y-webrtc handles Yjs sync and cross-tab
 * BroadcastChannel internally.
 *
 * @param signalingUrl WebSocket URL of the signaling server.
 * @param iceServers Optional custom ICE server list. Falls back to public STUN if omitted.
 */
export function createYWebrtcTransport(signalingUrl: string, iceServers?: RTCIceServer[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new YWebrtcTransport(signalingUrl, iceServers, deps)
}
