import { Bee, FeedIndex, NULL_STAMP, PrivateKey, Topic } from '@ethersphere/bee-js'

import type { StorageRead, SwarmStorage } from '../interfaces'
import { isNotFoundError, validateStamps } from '../utils/bee'
import { remove0x } from '../utils/common'
import { DEFERRED_FEED_UPLOAD } from '../utils/constants'

import { gsocCoordinates } from './gsoc'

const MIN_TTL_WARN_DAYS = 2

/** Options for `createBeeStorage`. */
export interface BeeStorageOptions {
  /** Bee node HTTP API URL (e.g. `"http://localhost:1633"`). */
  beeUrl: string
  /** Postage batch for every write. Omit it when `beeUrl` is a gateway that attaches its own stamp. */
  stamp?: string
  /** Identity key (hex, with or without 0x). It signs every feed this storage writes. */
  privateKey: string
}

/** Storage on a Bee node's HTTP API through bee-js. The page holds the identity key and signs every write. */
export function createBeeStorage(options: BeeStorageOptions): SwarmStorage {
  return new BeeStorage(options)
}

class BeeStorage implements SwarmStorage {
  public readonly owner: string
  private readonly bee: Bee
  private readonly beeUrl: string
  private readonly configuredStamp: string | undefined
  private readonly stamp: string
  private readonly signer: PrivateKey

  constructor({ beeUrl, stamp, privateKey }: BeeStorageOptions) {
    this.bee = new Bee(beeUrl)
    this.beeUrl = beeUrl
    this.configuredStamp = stamp
    this.stamp = stamp || NULL_STAMP.toHex()
    this.signer = new PrivateKey(remove0x(privateKey))
    this.owner = remove0x(this.signer.publicKey().address().toString())
  }

  async check(onWarn: (msg: string) => void): Promise<void> {
    await validateStamps(this.beeUrl, this.configuredStamp, MIN_TTL_WARN_DAYS, onWarn)
  }

  async readFeed(topic: Topic, owner: string, index: bigint): Promise<StorageRead> {
    try {
      const result = await this.bee.feed
        .makeReader(topic, owner)
        .downloadPayload({ index: FeedIndex.fromBigInt(index) })

      return { status: 'ok', data: result.payload.toUint8Array() }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  async feedHead(topic: Topic, owner: string): Promise<bigint | null> {
    try {
      return (await this.bee.feed.makeReader(topic, owner).downloadPayload()).feedIndex.toBigInt()
    } catch {
      return null
    }
  }

  async writeFeed(topic: Topic, index: bigint, data: Uint8Array): Promise<void> {
    await this.bee.feed.makeWriter(topic, this.signer).uploadPayload(this.stamp, data, {
      index: FeedIndex.fromBigInt(index),
      deferred: DEFERRED_FEED_UPLOAD,
    })
  }

  async readGsoc(topic: string): Promise<StorageRead> {
    const { identifier, owner } = await gsocCoordinates(topic)

    try {
      const soc = await this.bee.soc.makeReader(owner).download(identifier)

      return { status: 'ok', data: soc.payload.toUint8Array() }
    } catch (err) {
      return isNotFoundError(err) ? { status: 'absent' } : { status: 'failed', error: err }
    }
  }

  async sendGsoc(topic: string, data: Uint8Array): Promise<void> {
    const { identifier, signer } = await gsocCoordinates(topic)

    await this.bee.messaging.gsocSend(this.stamp, signer, identifier, data, { deferred: DEFERRED_FEED_UPLOAD })
  }
}
