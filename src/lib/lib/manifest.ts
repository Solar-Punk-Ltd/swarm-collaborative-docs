import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js'
import { MessageData, MessageType, Options, readSingleComment, writeCommentToIndex } from '@solarpunkltd/comment-system'

import { indexStrToBigint, remove0x, retryAwaitableAsync, uuidV4 } from '../utils/common'
import { ErrorHandler } from '../utils/error'

import { PLACEHOLDER_STAMP } from './constants'

const TAG = '[SwarmManifest]'

/**
 * Public consensus-key feed that stores the room's member list.
 *
 * The private key is derived deterministically from rawTopic so anyone who
 * knows the room topic can read and write the manifest without out-of-band
 * key sharing.  Last-write-wins; simultaneous join conflicts are acceptable.
 */
export class SwarmManifest {
  private readonly options: Options
  private readonly errorHandler = ErrorHandler.getInstance()

  constructor(rawTopic: string, beeUrl: string, stamp: string) {
    // Derive consensus keypair: Topic.fromString does keccak256 internally,
    // giving us a stable 32-byte seed that maps to a unique feed per room.
    const keyBytes = Topic.fromString(rawTopic + '_manifest_key')
    const consensusKey = new PrivateKey(keyBytes.toUint8Array())
    const address = consensusKey.publicKey().address().toString()
    const identifier = Topic.fromString(rawTopic + '_manifest').toString()

    this.options = {
      identifier,
      address,
      beeApiUrl: beeUrl,
      stamp: stamp || PLACEHOLDER_STAMP,
      signer: consensusKey,
    }

    console.log(`${TAG} consensus address: ${address}, identifier: ${identifier}`)
  }

  /** Returns the current member list, or [] if no manifest exists yet. */
  async read(): Promise<string[]> {
    try {
      const comment = await readSingleComment(undefined, this.options)

      if (!comment?.message) return []

      return JSON.parse(comment.message) as string[]
    } catch (err) {
      this.errorHandler.handleError(err, 'SwarmManifest.read')

      return []
    }
  }

  /**
   * Adds `address` to the manifest and writes it back to Swarm.
   *
   * Verifies the write by reading back the specific index.  On conflict
   * (two peers writing the same index simultaneously) the verified list
   * from Swarm is returned, which may or may not contain `address`.
   * This is acceptable — the peer that lost the race will retry on the
   * next join or can be added manually.
   *
   * Returns the resulting member list as confirmed by Swarm (or the
   * optimistic list if verification times out).
   */
  async addMember(address: string): Promise<string[]> {
    const identifier = this.options.identifier

    if (!identifier) {
      console.error(`${TAG} no identifier found`)

      return []
    }

    const normalized = remove0x(address.toLowerCase())

    // Read current manifest
    let members: string[] = []
    let currentIndex = -1n
    try {
      const comment = await readSingleComment(undefined, this.options)

      if (comment?.message) {
        members = JSON.parse(comment.message) as string[]
        const parsedIx = indexStrToBigint(comment.index)

        if (parsedIx !== undefined) currentIndex = parsedIx
      }
    } catch {
      // No manifest yet — start fresh at index 0
    }

    if (members.includes(normalized)) {
      console.log(`${TAG} addMember: ${normalized.slice(0, 8)} already in manifest`)

      return members
    }

    const nextMembers = [...members, normalized]
    const nextIndex = currentIndex === -1n ? 0n : currentIndex + 1n
    console.log(`${TAG} addMember: writing index ${nextIndex}, total members: ${nextMembers.length}`)

    const messageObj: MessageData = {
      id: uuidV4(),
      username: normalized,
      address: normalized,
      topic: identifier,
      signature: '',
      timestamp: Date.now(),
      type: MessageType.TEXT,
      message: JSON.stringify(nextMembers),
      index: FeedIndex.fromBigInt(nextIndex).toString(),
    }

    try {
      await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(nextIndex), this.options)
    } catch (err) {
      this.errorHandler.handleError(err, 'SwarmManifest.addMember write')

      return members // return pre-write list on failure
    }

    // Verify: read back what actually landed — detects conflicts
    const verified = await retryAwaitableAsync(
      () => readSingleComment(FeedIndex.fromBigInt(nextIndex), this.options),
      5,
      1000,
    )

    if (verified?.message) {
      try {
        const verifiedMembers = JSON.parse(verified.message) as string[]
        console.log(`${TAG} addMember: verified — members: ${verifiedMembers.join(', ')}`)

        return verifiedMembers
      } catch (err) {
        // parse error — return optimistic
        this.errorHandler.handleError(err, 'SwarmManifest.addMember parse error')
      }
    }

    console.log(`${TAG} addMember: verify timed out, using optimistic list`)

    return nextMembers
  }
}
