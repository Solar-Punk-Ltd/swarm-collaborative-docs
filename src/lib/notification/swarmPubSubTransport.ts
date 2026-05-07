import { Bee, PubsubMode, PubsubSubscription } from '@ethersphere/bee-js'

import { DOC_EVENTS } from '../doc/events'
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

const TAG = 'SwarmNotifTransport'
const WS_RECONNECT_TIMEOUT_MS = 10_000

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

  connectToPeer(_address: string): void {}

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }

  private connect(): void {
    if (this.stopped || this.isConnecting) return

    this.isConnecting = true

    const bee = new Bee(this.deps.beeApiUrl)

    const subscription = bee.pubsubConnect(
      PubsubMode.GSOC_EPHEMERAL,
      {
        onOpen: _sub => {
          this.isConnecting = false
          this.isConnected = true
          this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)
          this.logger.log(`${TAG} connected, docFeedId=${this.deps.docFeedId}`)

          // Drain buffered publishes now that the WebSocket is open
          const toSend = this.pendingPublishes.splice(0)
          for (const payload of toSend) {
            this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
          }
        },
        onMessage: (message, _sub) => {
          if (!this.handler) return

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
    if (!this.subscription) return

    const text = JSON.stringify(payload)
    await this.subscription.send(text)
  }
}

/**
 * Creates a `DocTransportFactory` using Swarm's GSOC pubsub for real-time notifications.
 *
 * Connects to the local Bee node's pubsub WebSocket endpoint and subscribes to a
 * content topic derived deterministically from the doc's feed ID using
 * `PubsubMode.GSOC_EPHEMERAL` (keccak256 of the topic string → ephemeral key → SOC address).
 * All peers using the same topic string subscribe to the same address, enabling
 * bidirectional push delivery without polling.
 *
 * Connection is established immediately in `start()`. If the WebSocket closes unexpectedly
 * it reconnects automatically after 3 seconds. `subscribe` and `publish` calls made before
 * the connection is ready are buffered and drained on connect.
 *
 * @param brokerPeer Multiaddress of the Bee node acting as the GSOC pubsub broker.
 *   Example: `/ip4/1.2.3.4/tcp/1634/p2p/QmXxxx…`
 */
export function createSwarmPubSubTransport(brokerPeer: string): DocTransportFactory {
  return (deps: DocTransportDeps) => new SwarmPubSubDocTransport(deps, brokerPeer)
}
