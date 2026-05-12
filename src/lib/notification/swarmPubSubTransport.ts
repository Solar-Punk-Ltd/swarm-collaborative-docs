import { Bee, PubsubMode, PubsubSubscription } from '@ethersphere/bee-js'

import { DOC_EVENTS } from '../doc/events'
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
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
    if (this.stopped || this.isConnecting) {
      return
    }

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
