import { Bee, Bytes, PrivateKey } from '@ethersphere/bee-js'

import { PLACEHOLDER_STAMP } from './constants'

export function getSigner(input: string): PrivateKey {
  const normalized = input.trim().toLowerCase()
  const inputBytes = Bytes.fromUtf8(normalized)
  const privateKeyHex = Bytes.keccak256(inputBytes).toHex()

  return new PrivateKey(privateKeyHex)
}

export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return (
    error.message?.includes('Not Found') ||
    error.message?.includes('404') ||
    (error as { stack?: string }).stack?.includes('404') ||
    false
  )
}

export const MIN_TTL_WARN_DAYS = 2

export async function validateStamps(
  beeUrl: string,
  stamp: string,
  mutableStamp: string,
  ttl: number = MIN_TTL_WARN_DAYS,
  onWarn?: (msg: string) => void,
): Promise<void> {
  const isPlaceholder = (id: string) => !id || id === PLACEHOLDER_STAMP

  if (isPlaceholder(stamp) && isPlaceholder(mutableStamp)) return

  const bee = new Bee(beeUrl)
  const batches = await bee.getPostageBatches()
  const usable = batches.filter(s => s.usable)

  const check = (id: string, label: string, mustBeMutable = false): void => {
    if (isPlaceholder(id)) return

    const found = usable.find(s => s.batchID.toString() === id)

    if (!found) throw new Error(`${label} stamp is not usable`)

    if (mustBeMutable && found.immutableFlag) {
      throw new Error(`${label} stamp must be a mutable batch`)
    }

    const daysLeft = found.duration.toDays()

    if (daysLeft < ttl) {
      onWarn?.(`${label} stamp expires in ~${daysLeft.toFixed(1)}d — consider topping up`)
    }
  }

  check(stamp, 'STAMP')
  check(mutableStamp, 'MUTABLE_STAMP', true)
}
