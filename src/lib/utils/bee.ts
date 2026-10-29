import { Bee, BeeResponseError, Bytes, PrivateKey } from '@ethersphere/bee-js'

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

/** `true` for an HTTP 404 from Bee, read from the status: a message or stack can contain "404" for other reasons. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof BeeResponseError && error.status === 404
}

const MIN_TTL_WARN_DAYS = 2
const GATEWAY_RESTRICTED_STATUSES = [401, 403, 404, 405]

/**
 * Throws if the node lists its batches and `stamp` is not usable there. Calls `onWarn` instead when no stamp is set
 * or the node does not expose `/stamps` (a gateway attaching its own stamp), and when under `ttl` days remain.
 */
export async function validateStamps(
  beeUrl: string,
  stamp: string | undefined,
  ttl: number = MIN_TTL_WARN_DAYS,
  onWarn?: (msg: string) => void,
): Promise<void> {
  if (!stamp) {
    onWarn?.(`No postage batch set: writes rely on ${beeUrl} attaching its own stamp.`)

    return
  }

  const bee = new Bee(beeUrl)
  const batches = await bee.stamp.getAll().catch((err: unknown) => {
    if (err instanceof BeeResponseError && GATEWAY_RESTRICTED_STATUSES.includes(err.status ?? 0)) return null
    throw err
  })

  if (!batches) {
    onWarn?.(`${beeUrl} does not expose /stamps (a gateway?): postage batch "${stamp}" was not verified.`)

    return
  }

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
