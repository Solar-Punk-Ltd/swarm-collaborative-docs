import { WebrtcProvider } from 'y-webrtc'

import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { remove0x } from '../utils/common'
import { Logger } from '../utils/logger'

const TAG = 'YWebrtcTransport'

class YWebrtcTransport implements DocTransport {
  private logger = Logger.getInstance()
  private provider: WebrtcProvider | null = null

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

    this.provider.awareness.on('change', () => {
      if (!this.provider) return

      for (const [clientId, state] of this.provider.awareness.getStates()) {
        const isSelf = clientId === this.provider.awareness.clientID
        const userState = (state as { user?: { address?: string } }).user
        const address = userState?.address ? remove0x(userState.address.toLowerCase()) : null

        if (!isSelf && address && address !== this.deps.ownAddress && !this.deps.members.has(address)) {
          this.logger.log(`${TAG} awareness: new peer ${address.slice(0, 8)}…`)
          // TODO: use username
          this.deps.onPeerDiscovered(address, 'unknown')
        }
      }
    })

    this.logger.log(`${TAG} started, room=${room}, signalingUrl=${this.signalingUrl}`)
  }

  stop(): void {
    this.provider?.destroy()
    this.provider = null
  }

  // y-webrtc manages peer connections automatically via the signaling server
  connectToPeer(_address: string): void {}

  // y-webrtc propagates updates via data channels — no notification publish needed
  subscribe(_topic: string, _handler: NotificationHandler): void {
    /** no-op */
  }
  publish(_payload: NotificationPayload): void {
    /** no-op */
  }

  isRemoteOrigin(origin: unknown): boolean {
    return this.provider !== null && origin === this.provider
  }
}

/**
 * Creates a `DocTransportFactory` using y-webrtc for real-time peer-to-peer sync.
 *
 * Establishes WebRTC data channels through a WebSocket signaling server (e.g. a
 * y-webrtc-compatible relay). Peer discovery is automatic via the `awareness` protocol —
 * no explicit `connectToPeer` calls are needed.
 *
 * Newly discovered peers are surfaced via `deps.onPeerDiscovered`, triggering a Swarm
 * snapshot fetch so document history written while the peer was offline is recovered.
 *
 * `subscribe` and `publish` are no-ops: y-webrtc propagates Yjs updates over data channels
 * internally and also handles cross-tab sync via its built-in BroadcastChannel.
 *
 * @param signalingUrl WebSocket URL of the signaling server.
 * @param iceServers Optional custom ICE server list. Falls back to public STUN if omitted.
 */
export function createYWebrtcTransport(signalingUrl: string, iceServers?: RTCIceServer[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new YWebrtcTransport(signalingUrl, iceServers, deps)
}
