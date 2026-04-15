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
import type { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { ErrorHandler } from '../utils/error'

const TAG = 'WakuTransport'

function contentTopicFor(topic: string): string {
  return `/swarm-collab-doc/1/${topic}/json`
}

class WakuDocTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private node: LightNode | null = null
  private stopped = false

  // Buffered until node is ready
  private pendingSubscription: { topic: string; handler: NotificationHandler } | null = null
  private pendingPublishes: NotificationPayload[] = []

  // Set once subscription is established; reused for all sends
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

  // Waku handles peer routing — no per-peer setup needed
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
    console.log(`${TAG} node connected`)
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
        console.log(`${TAG} subscribed to ${contentTopic} ok=${ok}`)
      })
      .catch(err => this.errorHandler.handleError(err, `${TAG}.subscribe`))
  }

  private async sendPayload(payload: NotificationPayload): Promise<void> {
    if (!this.node || !this.encoder) return

    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    const result = await this.node.lightPush.send(this.encoder, { payload: bytes })

    console.log(`${TAG} sent successes=${result.successes.length} failures=${result.failures.length}`)
  }
}

export function createWakuTransport(bootstrapPeers?: string[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new WakuDocTransport(deps, bootstrapPeers)
}
