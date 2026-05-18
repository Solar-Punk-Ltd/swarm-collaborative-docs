import { Bee, Bytes, PrivateKey } from '@ethersphere/bee-js'

import { PLACEHOLDER_STAMP } from './constants'

/**
 * Derives a deterministic `PrivateKey` from an arbitrary string input.
 * Used to create predictable, shared signers for consensus feeds (member list, signal)
 * without requiring out-of-band key distribution.
 *
 * @param input Any string (typically a feed ID or topic namespace).
 */
export function getSigner(input: string): PrivateKey {
  const normalized = input.trim().toLowerCase()
  const inputBytes = Bytes.fromUtf8(normalized)
  const privateKeyHex = Bytes.keccak256(inputBytes).toHex()

  return new PrivateKey(privateKeyHex)
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

/**
 * Validates the postage stamp against the connected Bee node.
 *
 * @param beeUrl Bee node HTTP API URL.
 * @param stamp Postage batch ID used for all writes.
 * @param ttl Minimum remaining TTL in days before a warning is issued. Defaults to 2.
 * @param onWarn Optional callback for warning messages (TTL near expiry, wrong batch type).
 * @throws If the stamp is not found in the node's usable batch list.
 */
export async function validateStamps(
  beeUrl: string,
  stamp: string,
  ttl: number = MIN_TTL_WARN_DAYS,
  onWarn?: (msg: string) => void,
): Promise<void> {
  const isPlaceholder = (id: string) => !id || id === PLACEHOLDER_STAMP

  if (isPlaceholder(stamp)) return

  const bee = new Bee(beeUrl)
  const batches = await bee.getPostageBatches()
  const usable = batches.filter(s => s.usable)

  const found = usable.find(s => s.batchID.toString() === stamp)

  if (!found) throw new Error(`Stamp is not usable`)

  const daysLeft = found.duration.toDays()

  if (daysLeft < ttl) {
    onWarn?.(`Stamp expires in ~${daysLeft.toFixed(1)}d — consider topping up`)
  }
}
