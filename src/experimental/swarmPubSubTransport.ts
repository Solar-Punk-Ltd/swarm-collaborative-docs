/*
 * NOT SHIPPED. Kept as a reference implementation only: this file is excluded from the
 * library entry point and the published bundle. It needs GSOC pubsub, which no released
 * Bee or `@ethersphere/bee-js` provides, so it cannot run against a public node today.
 */

import { Bee } from '@ethersphere/bee-js'

import { DOC_EVENTS } from '../lib/doc/events'
import { PeerConnectionState } from '../lib/interfaces'
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../lib/interfaces/doc'
import type { NotificationHandler, NotificationPayload } from '../lib/interfaces/notification'
import { ErrorHandler } from '../lib/utils/error'
import { Logger } from '../lib/utils/logger'

const TAG = 'SwarmNotifTransport'
const WS_RECONNECT_TIMEOUT_MS = 10_000
const GSOC_EPHEMERAL = 'gsoc-ephemeral'

/*
 * GSOC pubsub is not part of any released Bee or published bee-js yet, so its surface is declared
 * here structurally rather than imported. `connect()` feature-detects it and reports a clear error
 * when the installed bee-js has no pubsub, instead of failing to build.
 */
interface PubsubSubscription {
  send(data: string): Promise<unknown>
  cancel(): void
}

interface PubsubHandlers {
  onOpen: (sub: PubsubSubscription) => void
  onMessage: (message: { toUint8Array(): Uint8Array }, sub: PubsubSubscription) => void
  onError: (err: unknown, sub: PubsubSubscription) => void
  onClose: (sub: PubsubSubscription) => void
}

type PubsubCapableBee = Bee & {
  pubsubConnect(
    mode: string,
    handlers: PubsubHandlers,
    brokerPeer: string,
    options: { topic: string },
  ): PubsubSubscription
}

function withPubsub(bee: Bee): PubsubCapableBee | null {
  return typeof (bee as Partial<PubsubCapableBee>).pubsubConnect === 'function' ? (bee as PubsubCapableBee) : null
}

class SwarmPubSubDocTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private logger = Logger.getInstance()
  private subscription: PubsubSubscription | null = null
  private stopped = false
  private isConnecting = false
  private isConnected = false

  private handler: NotificationHandler | null = null
  private pendingPublishes: NotificationPayload[] = []

  constructor(
    private readonly deps: DocTransportDeps,
    private readonly brokerPeer: string,
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.isConnecting = false
    this.isConnected = false
    this.subscription?.cancel()
    this.subscription = null
  }

  subscribe(_topic: string, handler: NotificationHandler): void {
    this.handler = handler
  }

  publish(payload: NotificationPayload): void {
    if (this.isConnected) {
      this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
    } else {
      this.pendingPublishes.push(payload)
    }
  }

  connectToPeer(address: string): void {
    if (this.isConnected) {
      this.deps.members.setConnectionState(address, PeerConnectionState.Connected)
      this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())
    }
  }

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }

  private connect(): void {
    if (this.stopped || this.isConnecting) {
      return
    }

    this.isConnecting = true

    const bee = withPubsub(new Bee(this.deps.beeApiUrl))

    if (!bee) {
      this.isConnecting = false
      const err = new Error(
        'createSwarmPubSubTransport requires a bee-js build with GSOC pubsub support; use createSwarmRtcTransport instead',
      )
      this.errorHandler.handleError(err, `${TAG}.connect`)
      this.deps.emitter.emit(DOC_EVENTS.DOC_ERROR, err)

      return
    }

    const subscription = bee.pubsubConnect(
      GSOC_EPHEMERAL,
      {
        onOpen: _sub => {
          this.isConnecting = false
          this.isConnected = true
          this.deps.emitter.emit(DOC_EVENTS.TRANSPORT_READY, true)

          const peers = Array.from(this.deps.members.all().keys()).filter(addr => addr !== this.deps.ownAddress)
          for (const addr of peers) {
            this.deps.members.setConnectionState(addr, PeerConnectionState.Connected)
          }
          this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())

          if (peers.length > 0) {
            this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)
          }
          this.logger.log(`${TAG} connected, docFeedId=${this.deps.docFeedId}`)

          const toSend = this.pendingPublishes.splice(0)
          for (const payload of toSend) {
            this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
          }
        },
        onMessage: (message, _sub) => {
          if (!this.handler) {
            return
          }

          try {
            const text = new TextDecoder().decode(message.toUint8Array())
            const payload = JSON.parse(text) as NotificationPayload
            this.handler(payload)
          } catch (err) {
            this.errorHandler.handleError(err, `${TAG}.onMessage`)
          }
        },
        onError: (err, _sub) => {
          if (!this.stopped) {
            this.errorHandler.handleError(err, `${TAG}.onError`)
            this.isConnecting = false
            this.isConnected = false
          }
        },
        onClose: _sub => {
          if (!this.stopped) {
            this.logger.warn(`${TAG} connection closed, reconnecting…`)
            this.subscription = null
            this.isConnecting = false
            this.isConnected = false
            for (const addr of this.deps.members.all().keys()) {
              this.deps.members.setConnectionState(addr, PeerConnectionState.Registered)
            }
            this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())
            setTimeout(() => this.connect(), WS_RECONNECT_TIMEOUT_MS)
          }
        },
      },
      this.brokerPeer,
      { topic: this.deps.docFeedId },
    )

    this.subscription = subscription
  }

  private async sendPayload(payload: NotificationPayload): Promise<void> {
    if (!this.subscription) {
      return
    }

    const text = JSON.stringify(payload)
    await this.subscription.send(text)
  }
}

/**
 * Creates a `DocTransportFactory` using Swarm GSOC pubsub for real-time notifications.
 *
 * Subscribes to a content address derived from the doc's feed ID via
 * `PubsubMode.GSOC_EPHEMERAL` — all peers on the same topic reach the same address.
 * Reconnects automatically after 10 s if the WebSocket closes unexpectedly.
 * Publishes buffered during connect are drained on open.
 *
 * @param brokerPeer Multiaddress of the Bee node acting as the GSOC pubsub broker.
 */
export function createSwarmPubSubTransport(brokerPeer: string): DocTransportFactory {
  return (deps: DocTransportDeps) => new SwarmPubSubDocTransport(deps, brokerPeer)
}
