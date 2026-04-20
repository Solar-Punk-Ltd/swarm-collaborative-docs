import { Bee, PubsubMode, PubsubSubscription } from '@ethersphere/bee-js'

import { DOC_EVENTS } from '../doc/events'
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { ErrorHandler } from '../utils/error'

const TAG = 'SwarmNotifTransport'

class SwarmDocTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private subscription: PubsubSubscription | null = null
  private stopped = false

  // Buffered until the WebSocket is open
  private pendingHandler: { topic: string; handler: NotificationHandler } | null = null
  private pendingPublishes: NotificationPayload[] = []

  constructor(
    private readonly deps: DocTransportDeps,
    private readonly brokerPeer: string,
  ) {}

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.subscription?.cancel()
    this.subscription = null
  }

  subscribe(_topic: string, handler: NotificationHandler): void {
    if (this.subscription) {
      this.attachHandler(handler)
    } else {
      this.pendingHandler = { topic: _topic, handler }
    }
  }

  publish(payload: NotificationPayload): void {
    if (this.subscription) {
      this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
    } else {
      this.pendingPublishes.push(payload)
    }
  }

  // Channel-based: no per-peer connection needed
  connectToPeer(_address: string): void {}

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }

  private connect(): void {
    if (this.stopped) return

    const bee = new Bee(this.deps.beeApiUrl)

    const subscription = bee.pubsubConnect(
      PubsubMode.GSOC_EPHEMERAL,
      {
        onMessage: (message, _sub) => {
          if (!this.pendingHandler) return

          try {
            const text = new TextDecoder().decode(message.toUint8Array())
            const payload = JSON.parse(text) as NotificationPayload
            this.pendingHandler.handler(payload)
          } catch (err) {
            this.errorHandler.handleError(err, `${TAG}.onMessage`)
          }
        },
        onError: (err, _sub) => {
          if (!this.stopped) {
            this.errorHandler.handleError(err, `${TAG}.onError`)
          }
        },
        onClose: _sub => {
          if (!this.stopped) {
            console.warn(`${TAG} connection closed, reconnecting…`)
            this.subscription = null
            setTimeout(() => this.connect(), 3_000)
          }
        },
      },
      this.brokerPeer,
      { topic: this.deps.docFeedId },
    )

    this.subscription = subscription

    // Drain buffered handler and publishes
    if (this.pendingHandler) {
      const { handler } = this.pendingHandler
      this.attachHandler(handler)
    }

    for (const payload of this.pendingPublishes) {
      this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
    }

    this.pendingPublishes = []

    this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)
    console.log(`${TAG} connected, topicAddress derived from docFeedId=${this.deps.docFeedId}`)
  }

  private attachHandler(handler: NotificationHandler): void {
    // Store the active handler reference so onMessage can call it
    this.pendingHandler = { topic: '', handler }
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
export function createSwarmTransport(brokerPeer: string): DocTransportFactory {
  return (deps: DocTransportDeps) => new SwarmDocTransport(deps, brokerPeer)
}
