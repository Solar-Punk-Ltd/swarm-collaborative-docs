import { Bytes, PrivateKey } from '@ethersphere/bee-js'

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
