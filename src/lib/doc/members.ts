import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'

import { IMembers, PeerConnectionState } from '../interfaces'
import { getSigner, isNotFoundError } from '../utils/bee'
import { remove0x, retryAwaitableAsync } from '../utils/common'
import { MEMBERS_FEED_SUFFIX, PLACEHOLDER_STAMP } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

const TAG = 'Members'

export class Members implements IMembers {
  private readonly bee: Bee
  private readonly signer: PrivateKey
  private readonly topic: Topic
  private readonly address: string
  private readonly stamp: string
  private readonly errorHandler = ErrorHandler.getInstance()
  private readonly logger = Logger.getInstance()
  private currentIndex: bigint = -1n
  private readonly members: Map<string, string> = new Map()
  private readonly indices: Map<string, bigint> = new Map()
  private readonly connStates: Map<string, PeerConnectionState> = new Map()

  constructor(rawTopic: string, beeUrl: string, stamp: string) {
    const memberFeedId = Topic.fromString(rawTopic + MEMBERS_FEED_SUFFIX).toString()
    this.signer = getSigner(memberFeedId)
    this.address = this.signer.publicKey().address().toString()
    this.topic = Topic.fromString(memberFeedId)
    this.bee = new Bee(beeUrl)
    this.stamp = stamp || PLACEHOLDER_STAMP
  }

  register(address: string, username: string): boolean {
    if (this.members.has(address)) return false

    this.members.set(address, username)
    this.indices.set(address, -1n)

    return true
  }

  has(address: string): boolean {
    return this.members.has(address)
  }

  all(): ReadonlyMap<string, string> {
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

  async read(): Promise<Map<string, string> | null> {
    try {
      const reader = this.bee.makeFeedReader(this.topic, this.address)
      const result = await reader.downloadPayload()
      this.currentIndex = result.feedIndex.toBigInt()

      const parsed = JSON.parse(result.payload.toUtf8()) as Record<string, string>

      return new Map(Object.entries(parsed))
    } catch (err) {
      if (!isNotFoundError(err)) this.errorHandler.handleError(err, `${TAG}.read`)

      return null
    }
  }

  async add(address: string, username: string): Promise<Map<string, string>> {
    const normalizedAddress = remove0x(address.toLowerCase())
    const reader = this.bee.makeFeedReader(this.topic, this.address)
    const writer = this.bee.makeFeedWriter(this.topic, this.signer)
    const MAX_CONFLICT_RETRIES = 3

    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      // Always read latest — another peer may have written since our last attempt
      let members: Map<string, string> = new Map()
      try {
        const result = await reader.downloadPayload()

        if (result.payload.toUtf8().length) {
          const parsed = JSON.parse(result.payload.toUtf8()) as Record<string, string>
          members = new Map(Object.entries(parsed))
          this.currentIndex = result.feedIndex.toBigInt()
        }
      } catch (err) {
        if (!isNotFoundError(err)) this.errorHandler.handleError(err, `${TAG}.add read`)
        // Not found → fresh list, start at index 0
      }

      if (members.has(normalizedAddress)) {
        this.logger.debug(`${TAG} add: ${normalizedAddress.slice(0, 8)}… already in list`)

        return members
      }

      members.set(normalizedAddress, username)
      const nextIndex = this.currentIndex === -1n ? 0n : this.currentIndex + 1n

      try {
        await writer.uploadPayload(this.stamp, JSON.stringify(Object.fromEntries(members)), {
          index: FeedIndex.fromBigInt(nextIndex),
          deferred: false,
        })
        this.currentIndex = nextIndex
      } catch (err) {
        this.errorHandler.handleError(err, `${TAG}.add write`)

        return members
      }

      // Verify: read back to confirm own address survived a potential last-write-wins conflict
      try {
        const verified = await retryAwaitableAsync(
          async () => {
            const r = await reader.downloadPayload({ index: FeedIndex.fromBigInt(nextIndex) })
            const parsed = JSON.parse(r.payload.toUtf8()) as Record<string, string>

            return new Map(Object.entries(parsed))
          },
          3,
          500,
        )

        if (verified.has(normalizedAddress)) {
          this.logger.debug(`${TAG} add: verified — ${Array.from(verified.keys()).join(', ')}`)

          return verified
        }

        // Own address was overwritten by a simultaneous write — retry with fresh read
        this.logger.debug(`${TAG} add: conflict on attempt ${attempt + 1}, retrying`)
      } catch {
        this.logger.debug(`${TAG} add: verify timed out, using optimistic list`)

        return members
      }
    }

    this.logger.debug(`${TAG} add: could not confirm own address after ${MAX_CONFLICT_RETRIES} attempts`)

    return (await this.read()) ?? new Map([[normalizedAddress, username]])
  }
}
