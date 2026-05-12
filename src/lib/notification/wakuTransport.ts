import type { IDecodedMessage, LightNode } from '@waku/sdk'
import {
  createDecoder,
  createEncoder,
  createLightNode,
  DefaultNetworkConfig,
  HealthStatus,
  utils,
  WakuEvent,
} from '@waku/sdk'

import { DOC_EVENTS } from '../doc/events'
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

const TAG = 'WakuTransport'

function contentTopicFor(topic: string): string {
  return `/swarm-collab-doc/1/${topic}/json`
}

class WakuDocTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private logger = Logger.getInstance()
  private node: LightNode | null = null
  private stopped = false
  private pendingSubscription: { topic: string; handler: NotificationHandler } | null = null
  private pendingPublishes: NotificationPayload[] = []
  private encoder: ReturnType<typeof createEncoder> | null = null

  constructor(
    private readonly deps: DocTransportDeps,
    private readonly bootstrapPeers?: string[],
  ) {}

  start(): void {
    this.initNode().catch(err => this.errorHandler.handleError(err, `${TAG}.initNode`))
  }

  stop(): void {
    this.stopped = true

    if (this.node) {
      const n = this.node
      this.node = null
      n.filter.unsubscribeAll()
      n.stop().catch(err => this.errorHandler.handleError(err, `${TAG}.node.stop`))
    }
  }

  subscribe(topic: string, handler: NotificationHandler): void {
    if (this.node) {
      this.attachSubscription(topic, handler)
    } else {
      this.pendingSubscription = { topic, handler }
    }
  }

  publish(payload: NotificationPayload): void {
    if (this.node && this.encoder) {
      this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
    } else {
      this.pendingPublishes.push(payload)
    }
  }

  // Waku handles peer routing internally
  connectToPeer(_address: string): void {}

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }

  private async initNode(): Promise<void> {
    const nodeOptions = this.bootstrapPeers?.length
      ? { bootstrapPeers: this.bootstrapPeers }
      : { defaultBootstrap: true }

    const node = await createLightNode(nodeOptions)
    await node.start()
    await this.waitUntilHealthy(node, 15_000)

    if (this.stopped) {
      await node.stop()

      return
    }

    this.node = node
    this.logger.log(`${TAG} node connected`)
    this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)

    if (this.pendingSubscription) {
      const { topic, handler } = this.pendingSubscription
      this.pendingSubscription = null
      this.attachSubscription(topic, handler)
    }

    for (const payload of this.pendingPublishes) {
      if (this.encoder) {
        this.sendPayload(payload).catch(err => this.errorHandler.handleError(err, `${TAG}.sendPayload`))
      }
    }

    this.pendingPublishes = []
  }

  private waitUntilHealthy(node: LightNode, timeoutMs: number): Promise<void> {
    if (node.health !== HealthStatus.Unhealthy) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        node.events.removeEventListener(WakuEvent.Health, handler)
        reject(new Error(`${TAG} health timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      const handler = (event: CustomEvent<HealthStatus>) => {
        if (event.detail !== HealthStatus.Unhealthy) {
          clearTimeout(timer)
          node.events.removeEventListener(WakuEvent.Health, handler)
          resolve()
        }
      }

      node.events.addEventListener(WakuEvent.Health, handler)
    })
  }

  private attachSubscription(topic: string, handler: NotificationHandler): void {
    if (!this.node) return

    const contentTopic = contentTopicFor(topic)
    const routingInfo = utils.createRoutingInfo(DefaultNetworkConfig, { contentTopic })

    this.encoder = createEncoder({ contentTopic, routingInfo, ephemeral: true })
    const decoder = createDecoder(contentTopic, routingInfo)

    const callback = (message: IDecodedMessage) => {
      try {
        const text = new TextDecoder().decode(message.payload)
        const payload = JSON.parse(text) as NotificationPayload
        handler(payload)
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.onMessage`)
      }
    }

    this.node.filter
      .subscribe([decoder], callback)
      .then(ok => {
        this.logger.log(`${TAG} subscribed to ${contentTopic} ok=${ok}`)
      })
      .catch(err => this.errorHandler.handleError(err, `${TAG}.subscribe`))
  }

  private async sendPayload(payload: NotificationPayload): Promise<void> {
    if (!this.node || !this.encoder) {
      return
    }

    const bytes = new TextEncoder().encode(JSON.stringify(payload))

    try {
      const result = await this.node.lightPush.send(this.encoder, { payload: bytes })
      this.logger.debug(`${TAG} send successes=${result.successes.length} failures=${result.failures.length}`)
    } catch (err: unknown) {
      this.logger.error(`${TAG} unknown send error=${err}`)
    }
  }
}

/**
 * Creates a `DocTransportFactory` using the Waku network for real-time notifications.
 *
 * Spins up a Waku light node connected to the decentralised network via libp2p gossipsub.
 * Outgoing payloads use LightPush; incoming messages arrive via the Filter protocol.
 * `subscribe` and `publish` calls made before the node is ready are buffered and drained
 * automatically. `DOC_EVENTS.PEERS_CONNECTED` is emitted once the node is healthy.
 *
 * @param bootstrapPeers Optional libp2p multiaddr bootstrap peers. Defaults to Waku's public bootstrap set.
 */
export function createWakuTransport(bootstrapPeers?: string[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new WakuDocTransport(deps, bootstrapPeers)
}
