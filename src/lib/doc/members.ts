import { Topic } from '@ethersphere/bee-js'

import {
  AnnouncePayload,
  DirectoryPayload,
  IMembers,
  MemberEntry,
  PeerConnectionState,
  StorageRead,
  SwarmStorage,
} from '../interfaces'
import { remove0x, sleep } from '../utils/common'
import { API_VERSION, MEMBERS_FEED_SUFFIX } from '../utils/constants'
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
// The directory is one run of entries per room, so one probe key covers it.
const DIRECTORY_PROBE_KEY = 'directory'

function retryJitter(): number {
  return Math.floor(Math.random() * WRITE_RETRY_JITTER_MS)
}

/*
 * Each identity owns an announce feed listing its sessions, signed by the identity so nobody else can write it.
 * The directory, appendable by every key holder, only names identities, so members learn about newcomers. It is a run
 * of GSOC entries, one topic per index derived from the room key, because a GSOC key depends on its topic alone and
 * so every member can write it, through Freedom's `swarm_sendGsoc` or with bee-js and the same key.
 * Two tabs of one identity can still collide on their announce feed; the loser adopts the winner's entry and retries.
 */
function decodeJson<T>(read: StorageRead, valid: (payload: T) => boolean): FeedRead<T> {
  if (read.status !== 'ok') return read

  try {
    const payload = JSON.parse(new TextDecoder().decode(read.data)) as T

    return valid(payload) ? { status: 'ok', payload } : { status: 'absent' }
  } catch (err) {
    return { status: 'failed', error: err }
  }
}

function encodeJson(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export class Members implements IMembers {
  private readonly storage: SwarmStorage
  private readonly room: Room
  private readonly identity: string
  private readonly topic: Topic
  private readonly ownOwner: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private readonly probe = new FeedProbe()

  private ownIndex: bigint = -1n
  private ownIndexResolved = false
  private lastPublishAt = 0
  private publishedKnownCount = 0
  private directoryIndex: bigint = -1n
  private directoryResolved = false
  private directoryNextRead: bigint = 0n
  private lastDirectoryWriteAt = 0

  /** This session's own entries; the announce feed also repeats this identity's other sessions from the roster. */
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

  constructor(room: Room, storage: SwarmStorage) {
    this.room = room
    this.storage = storage
    this.identity = remove0x(storage.owner.toLowerCase())
    this.topic = Topic.fromString(room.namespace + MEMBERS_FEED_SUFFIX)
    this.ownOwner = room.announceOwner(this.identity)

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

    // Our own identity too: its other sessions (other tabs, earlier visits) are members whose feeds hold our work.
    for (let i = 0; i < queue.length && i < MAX_CRAWL_IDENTITIES; i++) {
      const payload = await this.readAnnounce(queue[i])

      if (payload) this.mergeAnnounce(payload, queue)
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

  // Sessions of this identity that are not this session's own: other tabs, and earlier visits.
  private ownIdentitySessions(): Map<string, MemberEntry> {
    return new Map([...this.roster].filter(([, entry]) => entry.identity === this.identity))
  }

  private merged(): Map<string, MemberEntry> {
    return new Map([...this.roster, ...this.ownSessions])
  }

  // Every directory entry counts, not just the newest: each names only the identities its writer added.
  private async readDirectory(): Promise<void> {
    const { next } = await drainFeed(
      index => this.readDirectoryIndex(index),
      this.directoryNextRead,
      DIRECTORY_PROBE_KEY,
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
    try {
      await this.resolveDirectoryTail()
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
        await this.storage.sendGsoc(this.room.directoryTopic(nextIndex), encodeJson(payload))
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.appendDirectory write`)

        return
      }

      const verified = await this.readDirectoryIndex(nextIndex)

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

  private async readDirectoryIndex(index: bigint): Promise<FeedRead<DirectoryPayload>> {
    return decodeJson<DirectoryPayload>(await this.storage.readGsoc(this.room.directoryTopic(index)), p =>
      Array.isArray(p?.identities),
    )
  }

  // GSOC entries have no head lookup: the walk starts at what this session has already read.
  private async resolveDirectoryTail(): Promise<void> {
    if (this.directoryResolved) return

    this.directoryIndex = await resolveFeedTail(
      () => Promise.resolve(this.directoryNextRead > 0n ? this.directoryNextRead - 1n : null),
      index => this.readDirectoryIndex(index),
      `${TAG} directory`,
    )
    this.directoryResolved = true
    this.logger.debug(`${TAG} directory feed tail resolved at index ${this.directoryIndex}`)
  }

  private async readAnnounce(identity: string): Promise<AnnouncePayload | null> {
    const owner = this.room.announceOwner(identity)

    const { latest, next } = await drainFeed(
      index => this.readIndex(owner, index),
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
    // The feed's owner, checked in readAnnounce, is the identity of every session it lists: the session's feeds are
    // read from that owner, so an entry naming another identity must not redirect them.
    const owner = remove0x(payload.identity.toLowerCase())

    for (const [address, listed] of Object.entries(payload.sessions ?? {})) {
      const key = remove0x(address.toLowerCase())
      const previous = this.roster.get(key)
      const entry = { ...listed, identity: owner }

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

  private async readIndex(owner: string, index: bigint): Promise<FeedRead<AnnouncePayload>> {
    return decodeJson<AnnouncePayload>(await this.storage.readFeed(this.topic, owner, index), p => Boolean(p?.identity))
  }

  // Republishes our `known` list once it has grown, at most once per cooldown.
  private async republishDirectoryIfStale(): Promise<void> {
    if (this.ownSessions.size === 0 || this.knownIdentities.size <= this.publishedKnownCount) return

    if (Date.now() - this.lastPublishAt < REFRESH_COOLDOWN_MS) return

    this.logger.debug(`${TAG} known list grew to ${this.knownIdentities.size} identity(s) — republishing`)
    await this.publish()
  }

  private async publish(): Promise<void> {
    try {
      await this.resolveOwnTail()
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.publish resolveTail`)

      return
    }

    // Only the newest announce entry counts, so it must carry this identity's earlier sessions as well, or a later
    // reader would never learn of them and never read what they wrote.
    const own = await this.readAnnounce(this.identity)

    if (own) this.mergeAnnounce(own, [])

    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const wanted = Array.from(this.ownSessions.keys())
      const payload: AnnouncePayload = {
        v: API_VERSION,
        identity: this.identity,
        sessions: { ...Object.fromEntries(this.ownIdentitySessions()), ...Object.fromEntries(this.ownSessions) },
        known: Array.from(this.knownIdentities),
      }

      const nextIndex = this.ownIndex + 1n
      // Claimed before the upload and kept on failure: a failed write may still have stored its chunk.
      this.ownIndex = nextIndex

      try {
        await this.storage.writeFeed(this.topic, nextIndex, encodeJson(payload))
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.publish write`)

        return
      }

      const verified = await this.readIndex(this.ownOwner, nextIndex)

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

  private async resolveOwnTail(): Promise<void> {
    if (this.ownIndexResolved) return

    this.ownIndex = await resolveFeedTail(
      () => this.storage.feedHead(this.topic, this.ownOwner),
      index => this.readIndex(this.ownOwner, index),
      `${TAG} own`,
    )
    this.ownIndexResolved = true
    this.logger.debug(`${TAG} own announce feed tail resolved at index ${this.ownIndex}`)
  }
}
