import { Bytes, EthAddress, Identifier, PrivateKey } from '@ethersphere/bee-js'

/*
 * GSOC coordinates for a topic, derived exactly as Freedom Browser's `swarm_sendGsoc` derives them (its
 * `messaging-service.js`, "Freedom profile v1"), so a Bee client and a Freedom page meet at the same chunk:
 *
 *   identifier    = keccak256(utf8(topic))
 *   targetOverlay = keccak256(utf8("freedom-gsoc-v1:" + topic))
 *   signer        = bee-js gsocMine(targetOverlay, identifier, 12)
 *
 * The key depends on the topic alone, so everyone who knows the topic can write there. Topics carry a hash of the
 * room key, never the key, because Freedom logs them.
 */

const GSOC_TARGET_CONTEXT = 'freedom-gsoc-v1:'
const GSOC_PROXIMITY = 12
// Same search as bee-js `messaging.gsocMine`: private keys counted up from 0xb33, the first one wins.
const MINE_START = 0xb33n
const MINE_LIMIT = 0xffffn
// Mining a key takes 0.3–2 s, so it yields to the page between slices instead of freezing it.
const MINE_SLICE_MS = 12
const CACHE_MAX = 256

/** Where a topic's GSOC chunk lives and the key that writes it. */
export interface GsocCoordinates {
  identifier: Identifier
  signer: PrivateKey
  owner: EthAddress
}

const cache = new Map<string, Promise<GsocCoordinates>>()

/** The GSOC coordinates of `topic`, mined once per topic and cached. */
export function gsocCoordinates(topic: string): Promise<GsocCoordinates> {
  const cached = cache.get(topic)

  if (cached) return cached

  const mined = mine(topic)

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(topic, mined)
  // A failure is not cached: the next call mines again.
  mined.catch(() => cache.delete(topic))

  return mined
}

async function mine(topic: string): Promise<GsocCoordinates> {
  const identifier = new Identifier(Bytes.keccak256(Bytes.fromUtf8(topic)))
  const target = Bytes.keccak256(Bytes.fromUtf8(GSOC_TARGET_CONTEXT + topic)).toUint8Array()
  const id = identifier.toUint8Array()
  let sliceStart = Date.now()

  for (let i = 0n; i < MINE_LIMIT; i++) {
    const signer = new PrivateKey(uint256(MINE_START + i))
    const owner = signer.publicKey().address()
    const address = Bytes.keccak256(concat(id, owner.toUint8Array())).toUint8Array()

    if (proximity(address, target) >= GSOC_PROXIMITY) {
      return { identifier, signer, owner }
    }

    if (Date.now() - sliceStart >= MINE_SLICE_MS) {
      await new Promise(resolve => setTimeout(resolve, 0))
      sliceStart = Date.now()
    }
  }

  throw new Error(`Could not mine a GSOC key for topic ${topic}`)
}

/** Leading bits two byte strings share. */
function proximity(a: Uint8Array, b: Uint8Array): number {
  for (let byte = 0; byte < a.length; byte++) {
    const diff = a[byte] ^ b[byte]

    if (diff !== 0) return byte * 8 + Math.clz32(diff) - 24
  }

  return a.length * 8
}

function uint256(n: bigint): Uint8Array {
  const out = new Uint8Array(32)

  for (let i = 31; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }

  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)

  return out
}
