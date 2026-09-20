import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { IMembers, MemberEntry, PeerConnectionState } from '../interfaces'
import { getSigner, isNotFoundError } from '../utils/bee'
import { remove0x } from '../utils/common'
import { DEFERRED_FEED_UPLOAD, MEMBERS_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'

const TAG = 'Members'
const MAX_CONFLICT_RETRIES = 3

/* Structural, so it survives bee-js accessor churn. */
interface FeedReader {
  downloadPayload(options?: { index: FeedIndex }): Promise<{ payload: { toUtf8(): string }; feedIndex: FeedIndex }>
}

/*
 * Unlike every other feed here, this one has many writers: its key is derived from the room topic,
 * so each participant holds the same key and appends to the same feed. Two peers writing at once
 * therefore resolve the same next index and produce two payloads for one chunk address, which the
 * node can then no longer serve — one simultaneous join or logout is enough.
 *
 * So collisions are treated as normal rather than exceptional: writes claim a tail found by probe,
 * a verify that cannot be read counts as a lost race and retries at the next index, and reads step
 * over a collided index once a later one proves the feed continues past it. A collision costs one
 * wasted index; it no longer walls off every entry written afterwards.
 *
 * The shared key is also why anyone who knows the topic can rewrite the member list. Replacing it
 * with per-session feeds plus a discovery mechanism is the real fix, and is not this change.
 */
export class Members implements IMembers {
  private readonly bee: Bee
  private readonly signer: PrivateKey
  private readonly topic: Topic
  private readonly address: string
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private readonly probe = new FeedProbe()
  private currentIndex: bigint = -1n
  private indexResolved = false
  /** Newest list read off the feed, so a write always merges into the freshest one it has seen. */
  private lastList: Map<string, MemberEntry> = new Map()
  private readonly members: Map<string, MemberEntry> = new Map()
  private readonly indices: Map<string, bigint> = new Map()
  private readonly connStates: Map<string, PeerConnectionState> = new Map()

  constructor(rawTopic: string, beeUrl: string, stamp: string) {
    const memberFeedId = Topic.fromString(rawTopic + MEMBERS_FEED_SUFFIX).toString()
    this.signer = getSigner(memberFeedId)
    this.address = this.signer.publicKey().address().toString()
    this.topic = Topic.fromString(memberFeedId)
    this.bee = new Bee(beeUrl)
    this.stamp = stamp
  }

  register(address: string, entry: MemberEntry): boolean {
    const existing = this.members.get(address)

    if (existing) {
      // A retired session that reappears is live again; keep the applied index either way.
      this.members.set(address, { ...existing, ...entry })

      return false
    }

    this.members.set(address, entry)
    this.indices.set(address, -1n)

    return true
  }

  has(address: string): boolean {
    return this.members.has(address)
  }

  get(address: string): MemberEntry | undefined {
    return this.members.get(address)
  }

  all(): ReadonlyMap<string, MemberEntry> {
    return new Map(this.members)
  }

  lastIndex(address: string): bigint {
    return this.indices.get(address) ?? -1n
  }

  setIndex(address: string, index: bigint): void {
    this.indices.set(address, index)
  }

  setConnectionState(address: string, state: PeerConnectionState): void {
    this.connStates.set(address, state)
  }

  allConnectionStates(): ReadonlyMap<string, PeerConnectionState> {
    return new Map(this.connStates)
  }

  /**
   * Returns the newest list written since the last read, or `null` when there is nothing new.
   *
   * Reads are by explicit index rather than by asking Bee for the feed's latest update: that
   * lookup probes with a one-second timeout and counts a slow probe as a miss, so on a loaded node
   * it reports a head below the real one — long enough for a peer that just joined to go unnoticed.
   */
  async read(): Promise<Map<string, MemberEntry> | null> {
    const reader = this.bee.feed.makeReader(this.topic, this.address)
    const firstRead = !this.indexResolved

    try {
      await this.resolveIndex(reader)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.read`)

      return null
    }

    // The tail itself has not been read yet on the first pass; later passes want what came after it.
    let from = 0n

    if (this.currentIndex >= 0n) {
      from = firstRead ? this.currentIndex : this.currentIndex + 1n
    }

    const { latest, next } = await drainFeed(
      index => this.readIndex(reader, index),
      from,
      this.address,
      this.probe,
      TAG,
    )

    if (latest) {
      this.lastList = latest
      this.currentIndex = next - 1n
    }

    return latest
  }

  private async readIndex(reader: FeedReader, index: bigint): Promise<FeedRead<Map<string, MemberEntry>>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })

      return { status: 'ok', payload: Members.parse(result.payload.toUtf8()) }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  private async resolveIndex(reader: FeedReader): Promise<void> {
    if (this.indexResolved) return

    this.currentIndex = await resolveFeedTail(
      () => this.latestIndex(reader),
      index => this.readIndex(reader, index),
      TAG,
    )
    this.indexResolved = true
    this.logger.debug(`${TAG} feed tail resolved at index ${this.currentIndex}`)
  }

  // Bee's own feed lookup. A miss means an empty feed; an error means the lookup itself is
  // unavailable, and the forward walk from index 0 answers the question without it.
  private async latestIndex(reader: FeedReader): Promise<bigint | null> {
    try {
      return (await reader.downloadPayload()).feedIndex.toBigInt()
    } catch (err) {
      if (!isNotFoundError(err)) {
        this.logger.debug(`${TAG} feed head lookup failed, walking from 0 instead: ${String(err)}`)
      }

      return null
    }
  }

  async retire(address: string): Promise<void> {
    const normalizedAddress = remove0x(address.toLowerCase())
    const existing = this.members.get(normalizedAddress)

    if (!existing) return

    const retired: MemberEntry = { ...existing, live: false, lastSeen: Date.now() }
    this.members.set(normalizedAddress, retired)

    try {
      await this.add(normalizedAddress, retired)
    } catch (err) {
      this.logger.debug(`${TAG} retire: ${normalizedAddress.slice(0, 8)}… failed — ${(err as Error).message}`)
    }
  }

  // Entries were plain usernames before sessions existed; upgrade them so older rooms still resolve.
  private static parse(payload: string): Map<string, MemberEntry> {
    if (!payload.length) return new Map()

    const parsed = JSON.parse(payload) as Record<string, MemberEntry | string>
    const entries = Object.entries(parsed).map(([address, value]): [string, MemberEntry] => [
      address,
      typeof value === 'string'
        ? { username: value, identity: address, sessionId: '', lastSeen: 0, live: true }
        : value,
    ])

    return new Map(entries)
  }

  async add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>> {
    const normalizedAddress = remove0x(address.toLowerCase())
    const reader = this.bee.feed.makeReader(this.topic, this.address)
    const writer = this.bee.feed.makeWriter(this.topic, this.signer)
    let members: Map<string, MemberEntry> = new Map()

    for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      // Re-read every attempt — another peer may have written since the last one.
      await this.read()
      members = new Map(this.lastList)
      const known = members.get(normalizedAddress)

      if (known && known.live === entry.live) {
        this.logger.debug(`${TAG} add: ${normalizedAddress.slice(0, 8)}… already in list`)

        return members
      }

      members.set(normalizedAddress, entry)

      const nextIndex = this.currentIndex + 1n
      // Claim the index before the upload and keep it claimed if the upload throws: a failed write
      // may still have stored its chunk, and reusing the index would put a second one there.
      this.currentIndex = nextIndex

      try {
        await writer.uploadPayload(this.stamp, JSON.stringify(Object.fromEntries(members)), {
          index: FeedIndex.fromBigInt(nextIndex),
          deferred: DEFERRED_FEED_UPLOAD,
        })
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.add write`)

        return members
      }

      const verified = await this.readIndex(reader, nextIndex)

      if (verified.status === 'ok') {
        // Whatever is at this index is now the truth — merge onto it, not onto our older copy.
        this.lastList = verified.payload

        if (verified.payload.has(normalizedAddress)) {
          this.logger.debug(`${TAG} add: verified — ${Array.from(verified.payload.keys()).join(', ')}`)

          return verified.payload
        }
      }

      /*
       * Two outcomes, one meaning: someone else wrote this index too. An `ok` payload without our
       * address is their write landing last; a payload that will not read at all is both writes
       * sitting at one address. Either way the entry did not make it, so try the next index —
       * treating an unreadable verify as success is what left a session invisible to its peers.
       */
      this.logger.debug(
        `${TAG} add: index ${nextIndex} lost to a concurrent write (${verified.status}), attempt ${attempt}`,
      )
    }

    this.logger.warn(`${TAG} add: could not confirm own address after ${MAX_CONFLICT_RETRIES} attempts`)

    return members
  }
}
