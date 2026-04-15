import { WebrtcProvider } from 'y-webrtc'

import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { remove0x } from '../utils/common'

const TAG = 'YWebrtcTransport'

class YWebrtcTransport implements DocTransport {
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
          console.log(`${TAG} awareness: new peer ${address.slice(0, 8)}…`)
          this.deps.onPeerDiscovered(address)
        }
      }
    })

    console.log(`${TAG} started, room=${room}, signalingUrl=${this.signalingUrl}`)
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

export function createYWebrtcTransport(signalingUrl: string, iceServers?: RTCIceServer[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new YWebrtcTransport(signalingUrl, iceServers, deps)
}
