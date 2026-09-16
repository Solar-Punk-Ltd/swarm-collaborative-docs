import type { WebrtcProvider } from 'y-webrtc'

import { DOC_EVENTS } from '../doc/events'
import { PeerConnectionState } from '../interfaces'
import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
import type { CursorPosition, NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { remove0x } from '../utils/common'
import { API_VERSION } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

import { assertIceServers, assertSignalingUrl } from './validate'

const TAG = 'SignalingServerTransport'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

interface AwarenessUser {
  user?: { address?: string; identity?: string; sessionId?: string; nickname?: string }
  cursor?: CursorPosition
}

class SignalingServerTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private logger = Logger.getInstance()
  private provider: WebrtcProvider | null = null
  private clientIdToAddress = new Map<number, string>()
  private handler: NotificationHandler | null = null
  private stopped = false

  constructor(
    private readonly signalingUrl: string,
    private readonly iceServers: RTCIceServer[],
    private readonly deps: DocTransportDeps,
  ) {}

  start(): void {
    this.init().catch(err => {
      this.errorHandler.handleError(err, `${TAG}.start`)
      this.deps.emitter.emit(
        DOC_EVENTS.DOC_ERROR,
        new Error(
          'y-webrtc is required by createSignalingServerTransport but could not be loaded. ' +
            'Install it as a dependency, or use createSwarmRtcTransport, which needs no extra package.',
        ),
      )
    })
  }

  // y-webrtc is an optional peer dependency, so it is resolved at start rather than at import:
  // a consumer on createSwarmRtcTransport must never be forced to bundle it.
  private async init(): Promise<void> {
    const { WebrtcProvider } = await import('y-webrtc')

    if (this.stopped) return

    const room = this.deps.docFeedId

    this.provider = new WebrtcProvider(room, this.deps.doc, {
      signaling: [this.signalingUrl],
      peerOpts: { config: { iceServers: this.iceServers } },
    })

    this.provider.awareness.setLocalStateField('user', {
      address: this.deps.ownAddress,
      identity: this.deps.ownIdentity,
      sessionId: this.deps.sessionId,
      nickname: this.deps.nickname,
    })

    this.deps.emitter.emit(DOC_EVENTS.TRANSPORT_READY, true)

    this.provider.awareness.on('change', (change: AwarenessChange) => this.onAwarenessChange(change))

    this.logger.log(`${TAG} started, room=${room}, signalingUrl=${this.signalingUrl}`)
  }

  private onAwarenessChange({ added, updated, removed }: AwarenessChange): void {
    if (!this.provider) return

    const states = this.provider.awareness.getStates() as Map<number, AwarenessUser>
    const ownClientId = this.provider.awareness.clientID

    for (const clientId of [...added, ...updated]) {
      if (clientId !== ownClientId) {
        this.onPeerPresent(clientId, states.get(clientId))
      }
    }

    for (const clientId of removed) {
      this.onPeerGone(clientId)
    }
  }

  private onPeerPresent(clientId: number, state: AwarenessUser | undefined): void {
    const address = state?.user?.address ? remove0x(state.user.address.toLowerCase()) : null
    const identity = state?.user?.identity ? remove0x(state.user.identity.toLowerCase()) : address

    if (!address || !identity || address === this.deps.ownAddress) return

    if (!this.deps.members.has(address)) {
      this.logger.log(`${TAG} awareness: new peer ${address.slice(0, 8)}…`)
      this.deps.onPeerDiscovered(address, {
        username: state?.user?.nickname ?? 'unknown',
        identity,
        sessionId: state?.user?.sessionId ?? '',
        lastSeen: Date.now(),
        live: true,
      })
      this.clientIdToAddress.set(clientId, address)
    }

    this.deps.members.setConnectionState(address, PeerConnectionState.Connected)
    this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())
    this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)

    if (state) {
      this.emitCursor(address, identity, state.user?.nickname ?? address.slice(0, 8), state.cursor ?? null)
    }
  }

  private onPeerGone(clientId: number): void {
    const address = this.getAddressForClientId(clientId)

    if (!address) return

    this.deps.members.setConnectionState(address, PeerConnectionState.Registered)
    this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())

    this.emitCursor(address, this.deps.members.get(address)?.identity ?? address, '', null)
  }

  private emitCursor(author: string, identity: string, username: string, cursor: CursorPosition): void {
    this.handler?.({
      type: 'cursor',
      v: API_VERSION,
      topic: this.deps.docFeedId,
      author,
      identity,
      username,
      cursor,
    })
  }

  stop(): void {
    this.stopped = true
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

/** Configuration for {@link createSignalingServerTransport}. */
export interface SignalingServerOptions {
  /**
   * WebSocket URL of a y-webrtc signaling server you run (`ws://` or `wss://`). Required —
   * the library ships no default, so a session can never silently point at a server that
   * does not exist.
   */
  signalingUrl: string

  /**
   * ICE servers used for every peer connection. Required — the library ships no default,
   * so connectivity is always a deliberate choice of the integrator.
   */
  iceServers: RTCIceServer[]
}

/**
 * Creates a `DocTransportFactory` that discovers peers through a WebSocket signaling server.
 *
 * Establishes WebRTC data channels via y-webrtc. Peer discovery is automatic through the
 * y-webrtc `awareness` protocol — no explicit `connectToPeer` calls are needed. New peers are
 * surfaced via `deps.onPeerDiscovered`, triggering a Swarm snapshot fetch for any history
 * written while the peer was offline.
 *
 * `subscribe` and `publish` are no-ops — y-webrtc handles Yjs sync and cross-tab
 * BroadcastChannel internally.
 *
 * Requires the optional peer dependency `y-webrtc`, loaded on `start()`. Choose this transport
 * when you operate the signaling server; choose `createSwarmRtcTransport` when you want no
 * server at all.
 *
 * @param options Must supply both `signalingUrl` and `iceServers`; neither has a default.
 * @throws If either option is missing or carries the wrong URL scheme.
 */
export function createSignalingServerTransport(options: SignalingServerOptions): DocTransportFactory {
  const signalingUrl = assertSignalingUrl('createSignalingServerTransport', options?.signalingUrl)
  const iceServers = assertIceServers('createSignalingServerTransport', options?.iceServers)

  return (deps: DocTransportDeps) => new SignalingServerTransport(signalingUrl, iceServers, deps)
}
