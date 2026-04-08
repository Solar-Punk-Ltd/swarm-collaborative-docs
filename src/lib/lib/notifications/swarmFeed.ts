import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { NotificationHandler, NotificationPayload, NotificationProvider } from '../../interfaces/notification'
import { remove0x } from '../../utils/common'

// Bee node returns 404 when a feed index SOC doesn't exist yet (normal "no new notification" case).
// It returns 500 when the SOC resolves but the referenced data chunk hasn't propagated to the
// local node yet. Both are "not available right now" — silently retry on next poll.
function isChunkUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return (
    error.stack?.includes('404') ||
    error.message?.includes('Not Found') ||
    error.message?.includes('404') ||
    error.stack?.includes('500') ||
    error.message?.includes('500') ||
    error.message?.includes('Internal Server Error') ||
    false
  )
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return error.name === 'AbortError' || error.message?.includes('aborted')
}

const POLL_INTERVAL_MS = 1500
// Max notifications to drain per member per poll cycle (handles burst edits)
const MAX_DRAIN = 10
// How long the Bee node searches the network for a chunk before returning 500.
const CHUNK_RETRIEVAL_TIMEOUT_MS = '1000ms'
const TAG = '[SwarmFeedNotificationProvider]'

export class SwarmFeedNotificationProvider implements NotificationProvider {
  private bee: Bee
  private signer: PrivateKey
  private mutableStamp: string
  private topic: string
  private ownAddress: string

  private handler: NotificationHandler | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private abortController: AbortController | null = null

  // address → next expected notification-feed index.
  // null = not yet anchored (first poll reads the pointer to find the current tip).
  private members: Map<string, FeedIndex | null> = new Map()

  // Tracks the next index to use when writing our own notification feed.
  // null = not yet probed (resolved on first publish).
  // Explicit tracking is required so we can write the pointer with the same index
  // immediately after writing the notification, without a separate network probe.
  private nextNotifyIndex: FeedIndex | null = null

  // Serialises publish calls so explicit index tracking stays consistent when
  // publish() is called again before the previous write resolves.
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
    return Topic.fromString(this.topic + '_notify' + address)
  }

  subscribe(_topic: string, handler: NotificationHandler): void {
    this.unsubscribe()
    this.handler = handler
    this.abortController = new AbortController()
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
  }

  // Fire-and-forget. Serialised via publishQueue so the explicit index counter
  // stays consistent even if called rapidly (e.g., quick successive edits).
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
      `${TAG} publish → notifyIndex=${writeIndex.toBigInt()} docFeedIndex=${payload.feedIndex} author=${payload.author.slice(0, 8)}… deltaBytes=${payload.delta ? Math.round(payload.delta.length * 0.75) : 0} t=${new Date(publishedAt).toISOString()}`,
    )

    const notifyWriter = this.bee.makeFeedWriter(this.notifyTopic(this.ownAddress), this.signer)
    await notifyWriter.uploadPayload(this.mutableStamp, data, {
      index: writeIndex,
      deferred: false,
    })

    // Advance local counter before writing the pointer so rapid re-entries
    // (shouldn't happen due to publishQueue, but just in case) are safe.
    this.nextNotifyIndex = writeIndex.next()

    console.debug(`${TAG} publish ✓ notifyIndex=${writeIndex.toBigInt()} writeLatency=${Date.now() - publishedAt}ms`)
  }

  addMember(address: string): void {
    if (address === this.ownAddress) return

    if (!this.members.has(address)) {
      this.members.set(address, null)
      console.log(`${TAG} addMember: ${address.slice(0, 8)}…`)
    }
  }

  private async poll(): Promise<void> {
    if (!this.handler || this.polling) return
    this.polling = true
    try {
      await Promise.allSettled([...this.members.keys()].map(address => this.pollMember(address)))
    } finally {
      this.polling = false
    }
  }

  private async pollMember(address: string): Promise<void> {
    const signal = this.abortController?.signal
    const nextExpected = this.members.get(address) ?? FeedIndex.fromBigInt(0n)

    const notifyReader = this.bee.makeFeedReader(this.notifyTopic(address), address, {
      headers: {
        'swarm-chunk-retrieval-timeout': CHUNK_RETRIEVAL_TIMEOUT_MS,
      },
      signal,
    })

    let nextIndex = nextExpected
    let drained = 0
    while (drained < MAX_DRAIN) {
      if (!this.handler || signal?.aborted) break

      let result
      try {
        result = await notifyReader.downloadPayload({ index: nextIndex })
      } catch (err) {
        if (!isChunkUnavailableError(err) && !isAbortError(err)) {
          console.error(`${TAG} drain failed for ${address.slice(0, 8)}…:`, err)
        }
        break // 404 = no new data yet
      }

      nextIndex = result.feedIndex.next()
      this.members.set(address, nextIndex)

      const raw = JSON.parse(result.payload.toUtf8()) as NotificationPayload & {
        _publishedAt?: number
      }
      const { _publishedAt: _, ...payload } = raw
      this.handler(payload)
      drained++
    }
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
