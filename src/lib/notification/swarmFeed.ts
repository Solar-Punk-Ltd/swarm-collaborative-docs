import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { DocTransport, DocTransportFactory } from '../interfaces/docTransport'
import { NotificationHandler, NotificationPayload, NotificationProvider } from '../interfaces/notification'
import { isNotFoundError } from '../utils/bee'
import { remove0x } from '../utils/common'
import { NOTIFY_FEED_SUFFIX } from '../utils/constants'

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return error.name === 'AbortError' || error.message?.includes('aborted')
}

const POLL_INTERVAL_MS = 1500
const SLOW_POLL_INTERVAL_MS = 5000
// Consecutive empty poll cycles before slowing down
const SLOW_POLL_THRESHOLD = 5
// Max notifications to drain per member per poll cycle (handles burst edits)
const MAX_DRAIN = 10
// How long the Bee node searches the network for a chunk before returning 500
const CHUNK_RETRIEVAL_TIMEOUT_MS = '1000ms'
const TAG = 'SwarmFeedNotificationProvider'

export class SwarmFeedNotificationProvider implements NotificationProvider {
  private bee: Bee
  private signer: PrivateKey
  private mutableStamp: string
  private topic: string
  private ownAddress: string

  private handler: NotificationHandler | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private currentPollIntervalMs = POLL_INTERVAL_MS
  private polling = false
  private abortController: AbortController | null = null
  private emptyPollCount = 0

  // address → next expected notification-feed index (null = not yet anchored)
  private members: Map<string, FeedIndex | null> = new Map()

  // Tracks the next index to write on own notification feed.
  // null = not yet probed (resolved on first publish).
  private nextNotifyIndex: FeedIndex | null = null

  // Serialises publish calls so the explicit index counter stays consistent
  // even when publish() is called rapidly (e.g. quick successive edits).
  private publishQueue: Promise<void> = Promise.resolve()

  constructor(beeApiUrl: string, privateKey: string, mutableStamp: string, topic: string) {
    this.bee = new Bee(beeApiUrl)
    this.signer = new PrivateKey(remove0x(privateKey))
    this.mutableStamp = mutableStamp
    this.topic = topic
    this.ownAddress = this.signer.publicKey().address().toString()
  }

  // Per-user notification feed topic: topic + "_notify" + address
  private notifyTopic(address: string): Topic {
    return Topic.fromString(this.topic + NOTIFY_FEED_SUFFIX + address)
  }

  subscribe(_topic: string, handler: NotificationHandler): void {
    this.unsubscribe()
    this.handler = handler
    this.currentPollIntervalMs = POLL_INTERVAL_MS
    this.emptyPollCount = 0
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
  }

  // Fire-and-forget. Serialised via publishQueue so index tracking stays consistent.
  publish(payload: NotificationPayload): void {
    this.publishQueue = this.publishQueue.then(() =>
      this.doPublish(payload).catch(err => {
        if (!isAbortError(err)) console.error(`${TAG} publish failed:`, err)
      }),
    )
  }

  private async doPublish(payload: NotificationPayload): Promise<void> {
    // Probe own notification feed once on first publish to find the tip index
    // (handles app restarts where the local counter was lost).
    if (this.nextNotifyIndex === null) {
      try {
        const reader = this.bee.makeFeedReader(this.notifyTopic(this.ownAddress), this.ownAddress)
        const tip = await reader.downloadPayload()
        this.nextNotifyIndex = tip.feedIndexNext ?? tip.feedIndex.next()
      } catch {
        // 404: never published before, start at index 0
        this.nextNotifyIndex = FeedIndex.fromBigInt(0n)
      }
    }

    const writeIndex = this.nextNotifyIndex
    const publishedAt = Date.now()
    const data = JSON.stringify({ ...payload, _publishedAt: publishedAt })

    console.debug(
      `${TAG} publish → notifyIndex=${writeIndex.toBigInt()} docFeedIndex=${payload.feedIndex} author=${payload.author.slice(0, 8)}… deltaBytes=${payload.delta ? Math.round(payload.delta.length * 0.75) : 0}`,
    )

    const notifyWriter = this.bee.makeFeedWriter(this.notifyTopic(this.ownAddress), this.signer)
    await notifyWriter.uploadPayload(this.mutableStamp, data, { index: writeIndex, deferred: false })

    // Advance local counter before the next enqueued publish can run
    this.nextNotifyIndex = writeIndex.next()
  }

  addMember(address: string): void {
    if (address === this.ownAddress || this.members.has(address)) return
    this.members.set(address, null)
    console.log(`${TAG} addMember: ${address.slice(0, 8)}…`)
  }

  private adjustPollInterval(newIntervalMs: number): void {
    if (this.currentPollIntervalMs === newIntervalMs || !this.pollTimer) return
    this.currentPollIntervalMs = newIntervalMs
    clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => this.poll(), newIntervalMs)
  }

  private async poll(): Promise<void> {
    if (!this.handler || this.polling) return
    this.polling = true

    // Fresh AbortController per cycle; abort the previous one in case it leaked
    const cycleController = new AbortController()
    const prev = this.abortController
    this.abortController = cycleController
    prev?.abort()

    try {
      const results = await Promise.allSettled(
        [...this.members.keys()].map(address => this.pollMember(address, cycleController.signal)),
      )

      const totalDrained = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0)

      if (totalDrained === 0) {
        this.emptyPollCount++

        if (this.emptyPollCount >= SLOW_POLL_THRESHOLD) {
          this.adjustPollInterval(SLOW_POLL_INTERVAL_MS)
        }
      } else {
        this.emptyPollCount = 0
        this.adjustPollInterval(POLL_INTERVAL_MS)
      }
    } finally {
      this.polling = false
    }
  }

  private async pollMember(address: string, signal: AbortController['signal']): Promise<number> {
    const nextExpected = this.members.get(address) ?? FeedIndex.fromBigInt(0n)

    const notifyReader = this.bee.makeFeedReader(this.notifyTopic(address), address, {
      headers: { 'swarm-chunk-retrieval-timeout': CHUNK_RETRIEVAL_TIMEOUT_MS },
      signal,
    })

    let nextIndex = nextExpected
    let drained = 0

    while (drained < MAX_DRAIN) {
      if (!this.handler || signal.aborted) break

      let result
      try {
        result = await notifyReader.downloadPayload({ index: nextIndex })
      } catch (err) {
        if (!isNotFoundError(err) && !isAbortError(err)) {
          console.error(`${TAG} drain failed for ${address.slice(0, 8)}…:`, err)
        }

        break
      }

      nextIndex = result.feedIndex.next()
      this.members.set(address, nextIndex)

      const raw = JSON.parse(result.payload.toUtf8()) as NotificationPayload & { _publishedAt?: number }
      const { _publishedAt: _, ...payload } = raw
      this.handler(payload)
      drained++
    }

    return drained
  }

  unsubscribe(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    this.abortController?.abort()
    this.abortController = null
    this.handler = null
    this.members.clear()
  }
}

class SwarmFeedDocTransport implements DocTransport {
  private provider: SwarmFeedNotificationProvider

  constructor(beeApiUrl: string, privateKey: string, mutableStamp: string, topic: string) {
    this.provider = new SwarmFeedNotificationProvider(beeApiUrl, privateKey, mutableStamp, topic)
  }

  start(): void {}

  stop(): void {
    this.provider.unsubscribe()
  }

  subscribe(topic: string, handler: NotificationHandler): void {
    this.provider.subscribe(topic, handler)
  }

  publish(payload: NotificationPayload): void {
    this.provider.publish(payload)
  }

  connectToPeer(address: string): void {
    this.provider.addMember(address)
  }

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }
}

export function createSwarmFeedTransport(
  beeApiUrl: string,
  privateKey: string,
  mutableStamp: string,
  topic: string,
): DocTransportFactory {
  return _deps => new SwarmFeedDocTransport(beeApiUrl, privateKey, mutableStamp, topic)
}
