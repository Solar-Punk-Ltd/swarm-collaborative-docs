import { ErrorHandler } from './error'
import { Logger } from './logger'

const logger = Logger.getInstance()
const errorHandler = ErrorHandler.getInstance()

export function sleep(delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay))
}

export function remove0x(hex: string): string {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase()
}

export async function retryAwaitableAsync<T>(fn: () => Promise<T>, retries = 3, baseDelay = 250): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (retries <= 0) {
      errorHandler.handleError(error, 'Utils.retryAwaitableAsync')
      throw error
    }
    logger.info(`Retrying in ${baseDelay}ms… (${retries} left). Error: ${(error as Error).message}`)
    await sleep(baseDelay)

    return retryAwaitableAsync(fn, retries - 1, baseDelay * 2)
  }
}

export const indexStrToBigint = (indexStr?: string): bigint | undefined => {
  if (!indexStr) return undefined

  const isHex = /[a-fA-F]/.test(indexStr) || indexStr.startsWith('0') || indexStr.length > 10

  if (isHex) {
    return BigInt(parseInt(indexStr, 16))
  }

  return BigInt(parseInt(indexStr, 10))
}

const BASE64_CHUNK_SIZE = 0x8000

export const encode = (bytes: Uint8Array): string => {
  let binary = ''

  // Chunked because String.fromCharCode(...bytes) overflows the call stack on large snapshots.
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE))
  }

  return btoa(binary)
}

export const decode = (b64: string): Uint8Array => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

export function uuidV4(): string {
  const pattern = '10000000-1000-4000-8000-100000000000'

  return pattern.replace(/[018]/g, (s: string) => {
    const c = parseInt(s, 10)

    return (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  })
}

export enum Origin {
  SwarmRtc = 'swarm-rtc',
  Remote = 'remote',
}
