import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { getSigner, isNotFoundError } from '../utils/bee'
import { remove0x, retryAwaitableAsync } from '../utils/common'
import { MEMBERS_FEED_SUFFIX, PLACEHOLDER_STAMP } from '../utils/constants'
import { ErrorHandler } from '../utils/error'

const TAG = 'Members'

/**
 * Manages the set of known peers for a collaborative doc session.
 *
 * Two layers of state:
 * - **Local session** — in-memory set of registered peer addresses and their last known feed index.
 * - **Swarm consensus** — append-only feed written by all peers, providing persistent discovery
 *   so late-joining peers can find each other without out-of-band key sharing.
 *
 * The consensus signer is derived deterministically from the room topic,
 * so any peer who knows the topic can read and write the member list.
 * Last-write-wins; simultaneous join conflicts are acceptable.
 */
export class Members {
  private readonly bee: Bee
  private readonly signer: PrivateKey
  private readonly topic: Topic
  private readonly address: string
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()

  // Swarm consensus state
  private currentIndex: bigint = -1n

  // Local session tracking
  private readonly addresses: Set<string> = new Set()
  private readonly indices: Map<string, bigint> = new Map()

  constructor(rawTopic: string, beeUrl: string, stamp: string) {
    const memberFeedId = Topic.fromString(rawTopic + MEMBERS_FEED_SUFFIX).toString()
    this.signer = getSigner(memberFeedId)
    this.address = this.signer.publicKey().address().toString()
    this.topic = Topic.fromString(memberFeedId)
    this.bee = new Bee(beeUrl)
    this.stamp = stamp || PLACEHOLDER_STAMP
    console.log(`${TAG} consensus address: ${this.address}`)
  }

  // ── Local session tracking ────────────────────────────────────────────────

  /**
   * Adds `address` to the local peer set.
   * @returns `true` if the address was newly added, `false` if already present.
   */
  register(address: string): boolean {
    if (this.addresses.has(address)) return false
    this.addresses.add(address)
    this.indices.set(address, -1n)

    return true
  }

  /** Returns `true` if `address` is in the local peer set. */
  has(address: string): boolean {
    return this.addresses.has(address)
  }

  /** Returns all registered peer addresses. */
  all(): string[] {
    return [...this.addresses]
  }

  /** Returns the last feed index applied from this peer, or -1n if none yet. */
  lastIndex(address: string): bigint {
    return this.indices.get(address) ?? -1n
  }

  /** Records the latest applied Swarm feed index for `address`. */
  setIndex(address: string, index: bigint): void {
    this.indices.set(address, index)
  }

  // ── Swarm consensus feed ──────────────────────────────────────────────────

  /**
   * Reads the current member list from the Swarm consensus feed.
   * @returns Array of Ethereum addresses, or `[]` if the feed does not exist yet.
   */
  async read(): Promise<string[]> {
    try {
      const reader = this.bee.makeFeedReader(this.topic, this.address)
      const result = await reader.downloadPayload()
      this.currentIndex = result.feedIndex.toBigInt()

      return JSON.parse(result.payload.toUtf8()) as string[]
    } catch (err) {
      if (!isNotFoundError(err)) this.errorHandler.handleError(err, `${TAG}.read`)

      return []
    }
  }

  /**
   * Adds `address` to the Swarm consensus member list.
   * Verifies by reading back the specific index to detect last-write-wins conflicts.
   * Returns the confirmed list, or the optimistic list if verification times out.
   */
  async add(address: string): Promise<string[]> {
    const normalizedAddress = remove0x(address.toLowerCase())
    const reader = this.bee.makeFeedReader(this.topic, this.address)

    // Always read latest — another peer may have added a member since our last write
    let members: string[] = []
    try {
      const result = await reader.downloadPayload()
      members = JSON.parse(result.payload.toUtf8()) as string[]
      this.currentIndex = result.feedIndex.toBigInt()
    } catch (err) {
      if (!isNotFoundError(err)) this.errorHandler.handleError(err, `${TAG}.add read`)
      // Not found → fresh list, start at index 0
    }

    if (members.includes(normalizedAddress)) {
      console.log(`${TAG} add: ${normalizedAddress.slice(0, 8)}… already in list`)

      return members
    }

    const nextMembers = [...members, normalizedAddress]
    const nextIndex = this.currentIndex === -1n ? 0n : this.currentIndex + 1n
    console.log(`${TAG} add: writing index ${nextIndex}, total: ${nextMembers.length}`)

    const writer = this.bee.makeFeedWriter(this.topic, this.signer)
    try {
      await writer.uploadPayload(this.stamp, JSON.stringify(nextMembers), {
        index: FeedIndex.fromBigInt(nextIndex),
        deferred: false,
      })
      this.currentIndex = nextIndex
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.add write`)

      return members
    }

    // Verify: read back to detect last-write-wins conflicts
    try {
      const verified = await retryAwaitableAsync(
        async () => {
          const r = await reader.downloadPayload({ index: FeedIndex.fromBigInt(nextIndex) })

          return JSON.parse(r.payload.toUtf8()) as string[]
        },
        3,
        500,
      )
      console.log(`${TAG} add: verified — ${verified.join(', ')}`)

      return verified
    } catch {
      console.log(`${TAG} add: verify timed out, using optimistic list`)

      return nextMembers
    }
  }
}
