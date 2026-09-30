import { Bee, Bytes, PrivateKey } from '@ethersphere/bee-js'

import { remove0x } from './common'

/** Deterministic private key from a string: keccak256 of its trimmed, lowercased UTF-8. */
export function getSigner(input: string): PrivateKey {
  const normalized = input.trim().toLowerCase()
  const inputBytes = Bytes.fromUtf8(normalized)
  const privateKeyHex = Bytes.keccak256(inputBytes).toHex()

  return new PrivateKey(privateKeyHex)
}

/** Signing key for one session of an identity, so tabs sharing an identity key never share feeds. */
export function deriveSessionSigner(privateKeyHex: string, sessionId: string): PrivateKey {
  return getSigner(`swarmdoc-session:v1:${remove0x(privateKeyHex)}:${sessionId}`)
}

/** Returns `true` if `error` represents an HTTP 404 / Not Found response from a Bee node. */
export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return (
    error.message?.includes('Not Found') ||
    error.message?.includes('404') ||
    (error as { stack?: string }).stack?.includes('404') ||
    false
  )
}

const MIN_TTL_WARN_DAYS = 2

/** Throws unless `stamp` is a usable batch on the node; calls `onWarn` when under `ttl` days remain. */
export async function validateStamps(
  beeUrl: string,
  stamp: string,
  ttl: number = MIN_TTL_WARN_DAYS,
  onWarn?: (msg: string) => void,
): Promise<void> {
  if (!stamp) {
    throw new Error(
      'A postage batch ID is required — every participant writes their own Swarm feed. ' +
        'Buy a batch on the Bee node you write through (its wallet needs xBZZ and xDAI), ' +
        'or point `infra.beeUrl` at a node that already has one.',
    )
  }

  const bee = new Bee(beeUrl)
  const batches = await bee.stamp.getAll()
  const usable = batches.filter(s => s.usable)

  const found = usable.find(s => s.batchID.toString() === stamp)

  if (!found) {
    throw new Error(
      `Postage batch "${stamp}" is not usable on ${beeUrl}. ` +
        'It must exist on this node, be fully purchased, and have remaining capacity and TTL.',
    )
  }

  const daysLeft = found.duration.toDays()

  if (daysLeft < ttl) {
    onWarn?.(`Stamp expires in ~${daysLeft.toFixed(1)}d — consider topping up`)
  }
}
