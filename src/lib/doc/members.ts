import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { AnnouncePayload, DirectoryPayload, IMembers, MemberEntry, PeerConnectionState } from '../interfaces'
import { isNotFoundError } from '../utils/bee'
import { remove0x, sleep } from '../utils/common'
import { API_VERSION, DEFERRED_FEED_UPLOAD, MEMBERS_FEED_SUFFIX } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { drainFeed, FeedProbe, FeedRead, resolveFeedTail } from '../utils/feed'
import { Logger } from '../utils/logger'
import { Room } from '../utils/room'

const TAG = 'Members'
const MAX_WRITE_RETRIES = 3
/** Announce feeds visited in one read. Bounds the crawl on a room that has seen many principals. */
const MAX_CRAWL_PRINCIPALS = 32
const REFRESH_COOLDOWN_MS = 60_000
/*
 * Two writers that collide on an index would otherwise both move to the next one and collide
 * again, since each is driven by the same verify-then-retry loop. A random pause breaks the step.
 */
const WRITE_RETRY_JITTER_MS = 400

function retryJitter(): number {
  return Math.floor(Math.random() * WRITE_RETRY_JITTER_MS)
}

/* Structural, so it survives bee-js accessor churn. */
interface FeedReader {
  downloadPayload(options?: { index: FeedIndex }): Promise<{ payload: { toUtf8(): string }; feedIndex: FeedIndex }>
}

/*
 * Discovery used to run through one feed that every participant wrote, its key derived from the
 * room topic. Two costs followed from that and both were fatal in practice: knowing the topic was
 * enough to rewrite the roster, and every writer republished the whole list from its own copy, so
 * a peer that merged from a list read before someone joined silently deleted them.
 *
 * Now each principal owns one announce feed holding its own sessions and writes nothing else into
 * it. Losing another member's entry is not possible, because no writer ever holds another member's
 * entry.
 *
 * One shared feed remains, and it has to: an announce feed is addressed from its principal, so a
 * principal nobody has heard of has no address anyone could poll, and a member already in the room
 * would never learn that someone new arrived. The directory feed carries that and only that — an
 * append-only log naming principals. Its entries are never rewritten, so a lost race costs an
 * index and a retry rather than deleting what was already listed, which is the whole of what went
 * wrong before. Announce payloads repeat the principals their writer knows, giving a second path
 * to the same information when a directory index is stuck behind a failed read.
 *
 * Two tabs of one identity share a principal and therefore an announce feed, so they can still
 * collide. That is contained rather than solved: the payload at stake is that identity's own
 * session list, the loser adopts whatever the winner wrote and retries at the next index, and the
 * tabs republish continuously. A per-browser writer election would remove it entirely.
 */
export class Members implements IMembers {
  private readonly bee: Bee
  private readonly room: Room
  private readonly principal: string
  private readonly topic: Topic
  private readonly ownSigner: PrivateKey
  private readonly ownOwner: string
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private readonly probe = new FeedProbe()

  private readonly directoryAddress: string
  private readonly directorySigner: PrivateKey

  private ownIndex: bigint = -1n
  private ownIndexResolved = false
  private lastPublishAt = 0
  private publishedKnownCount = 0
  private directoryIndex: bigint = -1n
  private directoryResolved = false
  private directoryNextRead: bigint = 0n
  private lastDirectoryWriteAt = 0

  /** This principal's own sessions — the only announce entries this node ever writes. */
  private readonly ownSessions: Map<string, MemberEntry> = new Map()
  /** Sessions learnt from other principals' announce feeds. */
  private readonly roster: Map<string, MemberEntry> = new Map()
  private readonly knownPrincipals: Set<string> = new Set()
  /** Principals confirmed present in the directory feed, so they need no further listing. */
  private readonly listedPrincipals: Set<string> = new Set()
  private readonly peerNextIndexes: Map<string, bigint> = new Map()

  private readonly members: Map<string, MemberEntry> = new Map()
  private readonly indices: Map<string, bigint> = new Map()
  private readonly connStates: Map<string, PeerConnectionState> = new Map()

  constructor(room: Room, principal: string, beeUrl: string, stamp: string) {
    this.room = room
    this.principal = remove0x(principal.toLowerCase())
    this.topic = Topic.fromString(room.namespace + MEMBERS_FEED_SUFFIX)
    this.ownSigner = room.announceSigner(this.principal)
    this.ownOwner = this.ownSigner.publicKey().address().toString()
    this.directorySigner = room.directorySigner()
    this.directoryAddress = room.directoryOwner()
    this.bee = new Bee(beeUrl)
    this.stamp = stamp

    this.knownPrincipals.add(this.principal)

    for (const seed of room.seeds()) {
      this.knownPrincipals.add(seed)
    }
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
   * Reads the room directory, then every announce feed it names, and merges what they hold.
   *
   * Reads are by explicit index rather than by asking Bee for a feed's latest update: that lookup
   * probes with a one-second timeout and counts a slow probe as a miss, so on a loaded node it
   * reports a head below the real one — long enough for a peer that just joined to go unnoticed.
   */
  async read(): Promise<Map<string, MemberEntry> | null> {
    await this.readDirectory()

    const queue = Array.from(this.knownPrincipals)

    for (let i = 0; i < queue.length && i < MAX_CRAWL_PRINCIPALS; i++) {
      const principal = queue[i]

      if (principal !== this.principal) {
        const payload = await this.readAnnounce(principal)

        if (payload) this.mergeAnnounce(payload, queue)
      }
    }

    await this.listUnlistedPrincipals()
    await this.republishDirectoryIfStale()

    const merged = this.merged()

    return merged.size > 0 ? merged : null
  }

  async add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>> {
    this.ownSessions.set(remove0x(address.toLowerCase()), entry)

    // Listed before announcing: a member already in the room polls the directory to learn that
    // this principal exists, and nothing else would tell them an announce feed is worth reading.
    await this.readDirectory()
    await this.listUnlistedPrincipals()
    await this.publish()

    return this.merged()
  }

  async retire(address: string): Promise<void> {
    const normalizedAddress = remove0x(address.toLowerCase())
    const existing = this.ownSessions.get(normalizedAddress)

    if (!existing) return

    this.ownSessions.set(normalizedAddress, { ...existing, live: false, lastSeen: Date.now() })

    try {
      await this.publish()
    } catch (err) {
      this.logger.debug(`${TAG} retire: ${normalizedAddress.slice(0, 8)}… failed — ${(err as Error).message}`)
    }
  }

  private merged(): Map<string, MemberEntry> {
    return new Map([...this.roster, ...this.ownSessions])
  }

  /*
   * Every entry matters here, unlike the announce feeds: the directory is an append-only log of
   * principals and the newest entry names only the principals its writer added. `drainFeed` reports
   * each one as it is read, and the cursor never moves over an index that was not read, so an entry
   * a peer has not written yet is waited on rather than stepped past.
   */
  private async readDirectory(): Promise<void> {
    const reader = this.bee.feed.makeReader(this.topic, this.directoryAddress)

    const { next } = await drainFeed(
      index => this.readDirectoryIndex(reader, index),
      this.directoryNextRead,
      this.directoryAddress,
      this.probe,
      `${TAG} directory`,
      payload => this.mergeDirectory(payload),
    )

    this.directoryNextRead = next
  }

  private mergeDirectory(payload: DirectoryPayload): void {
    for (const candidate of payload.principals ?? []) {
      const key = remove0x(candidate.toLowerCase())

      if (key) {
        this.listedPrincipals.add(key)

        if (!this.knownPrincipals.has(key)) {
          this.knownPrincipals.add(key)
          this.logger.debug(`${TAG} directory names principal ${key.slice(0, 8)}…`)
        }
      }
    }
  }

  /*
   * Adds anything known but not listed, which is both this session's own first join and a repair:
   * a principal learnt from another member's `known` list but missing from the directory would
   * otherwise stay invisible to everyone who has only ever read the directory. The own-principal
   * case is not rate limited, because it is the join path and a member nobody can see is useless.
   */
  private async listUnlistedPrincipals(): Promise<void> {
    const missing = Array.from(this.knownPrincipals).filter(principal => !this.listedPrincipals.has(principal))

    if (missing.length === 0) return

    if (!missing.includes(this.principal) && Date.now() - this.lastDirectoryWriteAt < REFRESH_COOLDOWN_MS) return

    await this.appendDirectory(missing)
  }

  private async appendDirectory(principals: string[]): Promise<void> {
    const reader = this.bee.feed.makeReader(this.topic, this.directoryAddress)
    const writer = this.bee.feed.makeWriter(this.topic, this.directorySigner)

    try {
      await this.resolveDirectoryTail(reader)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.appendDirectory resolveTail`)

      return
    }

    const payload: DirectoryPayload = { v: API_VERSION, principals }

    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const nextIndex = this.directoryIndex + 1n
      // Claim the index before the upload and keep it claimed if the upload throws: a failed write
      // may still have stored its chunk, and reusing the index would put a second one there.
      this.directoryIndex = nextIndex

      try {
        await writer.uploadPayload(this.stamp, JSON.stringify(payload), {
          index: FeedIndex.fromBigInt(nextIndex),
          deferred: DEFERRED_FEED_UPLOAD,
        })
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.appendDirectory write`)

        return
      }

      const verified = await this.readDirectoryIndex(reader, nextIndex)

      if (verified.status === 'ok') {
        // Whoever holds this index, their principals are now listed — take them either way.
        this.mergeDirectory(verified.payload)

        if (principals.every(principal => this.listedPrincipals.has(principal))) {
          this.lastDirectoryWriteAt = Date.now()
          this.logger.debug(`${TAG} directory index ${nextIndex}: listed ${principals.length} principal(s)`)

          return
        }
      }

      this.logger.debug(
        `${TAG} directory index ${nextIndex} lost to a concurrent write (${verified.status}), attempt ${attempt}`,
      )
      await sleep(retryJitter())
    }

    this.logger.warn(`${TAG} could not list ${principals.length} principal(s) after ${MAX_WRITE_RETRIES} attempts`)
  }

  private async readDirectoryIndex(reader: FeedReader, index: bigint): Promise<FeedRead<DirectoryPayload>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })
      const payload = JSON.parse(result.payload.toUtf8()) as DirectoryPayload

      if (!Array.isArray(payload?.principals)) {
        return { status: 'absent' }
      }

      return { status: 'ok', payload }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  private async resolveDirectoryTail(reader: FeedReader): Promise<void> {
    if (this.directoryResolved) return

    this.directoryIndex = await resolveFeedTail(
      () => this.latestIndex(reader),
      index => this.readDirectoryIndex(reader, index),
      `${TAG} directory`,
    )
    this.directoryResolved = true
    this.logger.debug(`${TAG} directory feed tail resolved at index ${this.directoryIndex}`)
  }

  private async readAnnounce(principal: string): Promise<AnnouncePayload | null> {
    const owner = this.room.announceOwner(principal)
    const reader = this.bee.feed.makeReader(this.topic, owner)

    const { latest, next } = await drainFeed(
      index => this.readIndex(reader, index),
      this.peerNextIndexes.get(principal) ?? 0n,
      owner,
      this.probe,
      `${TAG} announce(${principal.slice(0, 8)}…)`,
    )

    this.peerNextIndexes.set(principal, next)

    return latest
  }

  private mergeAnnounce(payload: AnnouncePayload, queue: string[]): void {
    for (const [address, entry] of Object.entries(payload.sessions ?? {})) {
      const key = remove0x(address.toLowerCase())
      const previous = this.roster.get(key)

      // `lastSeen` only ever moves forward on a writer's own feed, so it orders their own writes;
      // there is no second writer to order against.
      if (key !== '' && !this.ownSessions.has(key) && (!previous || entry.lastSeen >= previous.lastSeen)) {
        this.roster.set(key, entry)
      }
    }

    for (const candidate of payload.known ?? []) {
      const key = remove0x(candidate.toLowerCase())

      if (key && !this.knownPrincipals.has(key)) {
        this.knownPrincipals.add(key)
        queue.push(key)
        this.logger.debug(`${TAG} discovered principal ${key.slice(0, 8)}… via ${payload.principal.slice(0, 8)}…`)
      }
    }
  }

  private async readIndex(reader: FeedReader, index: bigint): Promise<FeedRead<AnnouncePayload>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })
      const payload = JSON.parse(result.payload.toUtf8()) as AnnouncePayload

      if (!payload?.principal) {
        return { status: 'absent' }
      }

      return { status: 'ok', payload }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  /*
   * The `known` list in an announce payload is a snapshot of what its writer knew when it wrote,
   * so it goes stale as the room grows. It is a second path to the same principals the directory
   * feed carries, useful when a directory index is stuck behind a failed read, and it is worth
   * keeping fresh — but only at one feed write per interval, however fast the room widens.
   */
  private async republishDirectoryIfStale(): Promise<void> {
    if (this.ownSessions.size === 0 || this.knownPrincipals.size <= this.publishedKnownCount) return

    if (Date.now() - this.lastPublishAt < REFRESH_COOLDOWN_MS) return

    this.logger.debug(`${TAG} known list grew to ${this.knownPrincipals.size} principal(s) — republishing`)
    await this.publish()
  }

  private async publish(): Promise<void> {
    const reader = this.bee.feed.makeReader(this.topic, this.ownOwner)
    const writer = this.bee.feed.makeWriter(this.topic, this.ownSigner)

    try {
      await this.resolveOwnTail(reader)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.publish resolveTail`)

      return
    }

    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const wanted = Array.from(this.ownSessions.keys())
      const payload: AnnouncePayload = {
        v: API_VERSION,
        principal: this.principal,
        sessions: Object.fromEntries(this.ownSessions),
        known: Array.from(this.knownPrincipals),
      }

      const nextIndex = this.ownIndex + 1n
      // Claim the index before the upload and keep it claimed if the upload throws: a failed write
      // may still have stored its chunk, and reusing the index would put a second one there.
      this.ownIndex = nextIndex

      try {
        await writer.uploadPayload(this.stamp, JSON.stringify(payload), {
          index: FeedIndex.fromBigInt(nextIndex),
          deferred: DEFERRED_FEED_UPLOAD,
        })
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.publish write`)

        return
      }

      const verified = await this.readIndex(reader, nextIndex)

      if (verified.status === 'ok') {
        const written = verified.payload.sessions ?? {}

        // Another tab of this identity may have taken the index. Adopt whatever it wrote before
        // retrying, so this node's next payload carries its sessions instead of dropping them.
        for (const [address, entry] of Object.entries(written)) {
          if (!this.ownSessions.has(address)) this.ownSessions.set(address, entry)
        }

        if (wanted.every(address => written[address])) {
          this.lastPublishAt = Date.now()
          this.publishedKnownCount = payload.known.length
          this.logger.debug(
            `${TAG} published index ${nextIndex}: ${wanted.length} session(s), ${payload.known.length} principal(s)`,
          )

          return
        }
      }

      this.logger.debug(
        `${TAG} publish: index ${nextIndex} lost to a concurrent write (${verified.status}), attempt ${attempt}`,
      )
      await sleep(retryJitter())
    }

    this.logger.warn(`${TAG} publish: could not confirm own sessions after ${MAX_WRITE_RETRIES} attempts`)
  }

  private async resolveOwnTail(reader: FeedReader): Promise<void> {
    if (this.ownIndexResolved) return

    this.ownIndex = await resolveFeedTail(
      () => this.latestIndex(reader),
      index => this.readIndex(reader, index),
      `${TAG} own`,
    )
    this.ownIndexResolved = true
    this.logger.debug(`${TAG} own announce feed tail resolved at index ${this.ownIndex}`)
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
}
