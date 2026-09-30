import type { FeedReader } from '@ethersphere/bee-js'
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
// Announce feeds visited per read, bounding the crawl.
const MAX_CRAWL_IDENTITIES = 32
const REFRESH_COOLDOWN_MS = 60_000
// Random pause, so two writers that collided on an index do not collide again on the next.
const WRITE_RETRY_JITTER_MS = 400

function retryJitter(): number {
  return Math.floor(Math.random() * WRITE_RETRY_JITTER_MS)
}

/*
 * Each identity owns an announce feed listing its sessions, signed by the identity so nobody else can write it.
 * The directory feed, appendable by every key holder, only names identities, so members learn about newcomers.
 * Two tabs of one identity can still collide on their announce feed; the loser adopts the winner's entry and retries.
 */
export class Members implements IMembers {
  private readonly bee: Bee
  private readonly room: Room
  private readonly identity: string
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

  /** This identity's own sessions — the only announce entries this node ever writes. */
  private readonly ownSessions: Map<string, MemberEntry> = new Map()
  /** Sessions learnt from other identities' announce feeds. */
  private readonly roster: Map<string, MemberEntry> = new Map()
  private readonly knownIdentities: Set<string> = new Set()
  /** identities confirmed present in the directory feed, so they need no further listing. */
  private readonly listedIdentities: Set<string> = new Set()
  private readonly peerNextIndexes: Map<string, bigint> = new Map()

  private readonly members: Map<string, MemberEntry> = new Map()
  private readonly indices: Map<string, bigint> = new Map()
  private readonly connStates: Map<string, PeerConnectionState> = new Map()

  constructor(room: Room, identitySigner: PrivateKey, beeUrl: string, stamp: string) {
    this.room = room
    this.identity = remove0x(identitySigner.publicKey().address().toString().toLowerCase())
    this.topic = Topic.fromString(room.namespace + MEMBERS_FEED_SUFFIX)
    this.ownSigner = identitySigner
    this.ownOwner = room.announceOwner(this.identity)
    this.directorySigner = room.directorySigner()
    this.directoryAddress = room.directoryOwner()
    this.bee = new Bee(beeUrl)
    this.stamp = stamp

    this.knownIdentities.add(this.identity)

    for (const seed of room.seeds()) {
      this.knownIdentities.add(seed)
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

  // By explicit index: Bee's latest-update lookup under-reports on a loaded node and would hide a new peer.
  async read(): Promise<Map<string, MemberEntry> | null> {
    await this.readDirectory()

    const queue = Array.from(this.knownIdentities)

    for (let i = 0; i < queue.length && i < MAX_CRAWL_IDENTITIES; i++) {
      const identity = queue[i]

      if (identity !== this.identity) {
        const payload = await this.readAnnounce(identity)

        if (payload) this.mergeAnnounce(payload, queue)
      }
    }

    await this.listUnlistedIdentities()
    await this.republishDirectoryIfStale()

    const merged = this.merged()

    return merged.size > 0 ? merged : null
  }

  async add(address: string, entry: MemberEntry): Promise<Map<string, MemberEntry>> {
    this.ownSessions.set(remove0x(address.toLowerCase()), entry)

    // Listed before announcing: the directory is how existing members learn this identity exists.
    await this.readDirectory()
    await this.listUnlistedIdentities()
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

  // Every directory entry counts, not just the newest: each names only the identities its writer added.
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
    for (const candidate of payload.identities ?? []) {
      const key = remove0x(candidate.toLowerCase())

      if (key) {
        this.listedIdentities.add(key)

        if (!this.knownIdentities.has(key)) {
          this.knownIdentities.add(key)
          this.logger.debug(`${TAG} directory names identity ${key.slice(0, 8)}…`)
        }
      }
    }
  }

  // Lists known but unlisted identities: our own on join (never rate limited), and repairs for others.
  private async listUnlistedIdentities(): Promise<void> {
    const missing = Array.from(this.knownIdentities).filter(identity => !this.listedIdentities.has(identity))

    if (missing.length === 0) return

    if (!missing.includes(this.identity) && Date.now() - this.lastDirectoryWriteAt < REFRESH_COOLDOWN_MS) return

    await this.appendDirectory(missing)
  }

  private async appendDirectory(identities: string[]): Promise<void> {
    const reader = this.bee.feed.makeReader(this.topic, this.directoryAddress)
    const writer = this.bee.feed.makeWriter(this.topic, this.directorySigner)

    try {
      await this.resolveDirectoryTail(reader)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.appendDirectory resolveTail`)

      return
    }

    const payload: DirectoryPayload = { v: API_VERSION, identities }

    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const nextIndex = this.directoryIndex + 1n
      // Claimed before the upload and kept on failure: a failed write may still have stored its chunk.
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
        // Whoever holds this index, their identities are now listed — take them either way.
        this.mergeDirectory(verified.payload)

        if (identities.every(identity => this.listedIdentities.has(identity))) {
          this.lastDirectoryWriteAt = Date.now()
          this.logger.debug(`${TAG} directory index ${nextIndex}: listed ${identities.length} identity(s)`)

          return
        }
      }

      this.logger.debug(
        `${TAG} directory index ${nextIndex} lost to a concurrent write (${verified.status}), attempt ${attempt}`,
      )
      await sleep(retryJitter())
    }

    this.logger.warn(`${TAG} could not list ${identities.length} identity(s) after ${MAX_WRITE_RETRIES} attempts`)
  }

  private async readDirectoryIndex(reader: FeedReader, index: bigint): Promise<FeedRead<DirectoryPayload>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })
      const payload = JSON.parse(result.payload.toUtf8()) as DirectoryPayload

      if (!Array.isArray(payload?.identities)) {
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

  private async readAnnounce(identity: string): Promise<AnnouncePayload | null> {
    const owner = this.room.announceOwner(identity)
    const reader = this.bee.feed.makeReader(this.topic, owner)

    const { latest, next } = await drainFeed(
      index => this.readIndex(reader, index),
      this.peerNextIndexes.get(identity) ?? 0n,
      owner,
      this.probe,
      `${TAG} announce(${identity.slice(0, 8)}…)`,
    )

    this.peerNextIndexes.set(identity, next)

    if (latest && remove0x(latest.identity.toLowerCase()) !== identity) {
      this.logger.debug(`${TAG} announce(${identity.slice(0, 8)}…) claims a different identity — ignored`)

      return null
    }

    return latest
  }

  private mergeAnnounce(payload: AnnouncePayload, queue: string[]): void {
    for (const [address, entry] of Object.entries(payload.sessions ?? {})) {
      const key = remove0x(address.toLowerCase())
      const previous = this.roster.get(key)

      // `lastSeen` only moves forward on its writer's own feed, so it orders that writer's entries.
      if (key !== '' && !this.ownSessions.has(key) && (!previous || entry.lastSeen >= previous.lastSeen)) {
        this.roster.set(key, entry)
      }
    }

    for (const candidate of payload.known ?? []) {
      const key = remove0x(candidate.toLowerCase())

      if (key && !this.knownIdentities.has(key)) {
        this.knownIdentities.add(key)
        queue.push(key)
        this.logger.debug(`${TAG} discovered identity ${key.slice(0, 8)}… via ${payload.identity.slice(0, 8)}…`)
      }
    }
  }

  private async readIndex(reader: FeedReader, index: bigint): Promise<FeedRead<AnnouncePayload>> {
    try {
      const result = await reader.downloadPayload({ index: FeedIndex.fromBigInt(index) })
      const payload = JSON.parse(result.payload.toUtf8()) as AnnouncePayload

      if (!payload?.identity) {
        return { status: 'absent' }
      }

      return { status: 'ok', payload }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  // Republishes our `known` list once it has grown, at most once per cooldown.
  private async republishDirectoryIfStale(): Promise<void> {
    if (this.ownSessions.size === 0 || this.knownIdentities.size <= this.publishedKnownCount) return

    if (Date.now() - this.lastPublishAt < REFRESH_COOLDOWN_MS) return

    this.logger.debug(`${TAG} known list grew to ${this.knownIdentities.size} identity(s) — republishing`)
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
        identity: this.identity,
        sessions: Object.fromEntries(this.ownSessions),
        known: Array.from(this.knownIdentities),
      }

      const nextIndex = this.ownIndex + 1n
      // Claimed before the upload and kept on failure: a failed write may still have stored its chunk.
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

        // Another tab of this identity may have taken the index: adopt its sessions before retrying.
        for (const [address, entry] of Object.entries(written)) {
          if (!this.ownSessions.has(address)) this.ownSessions.set(address, entry)
        }

        if (wanted.every(address => written[address])) {
          this.lastPublishAt = Date.now()
          this.publishedKnownCount = payload.known.length
          this.logger.debug(
            `${TAG} published index ${nextIndex}: ${wanted.length} session(s), ${payload.known.length} identity(s)`,
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

  // Bee's head lookup; `null` on a miss or error, and the forward walk takes over.
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
