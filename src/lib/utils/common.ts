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

const ENCODING = 'base64'

export const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString(ENCODING)

export const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, ENCODING))

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
