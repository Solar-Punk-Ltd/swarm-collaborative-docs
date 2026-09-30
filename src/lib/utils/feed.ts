import { Logger } from './logger'

/*
 * Index handling for the append-only feeds this library writes. A failed read means unknown, never absent: once
 * every retrieval peer has failed on a chunk, Bee answers 500 for it for a minute (`errSkip`), so polling an index
 * too early makes it unreadable. Only a later readable index proves one is stuck. Writes never reuse an index,
 * so resolving a tail errs towards overshooting.
 */

const logger = Logger.getInstance()

/** Outcome of reading one feed index. `failed` is unknown, and is never treated as either of the others. */
export type FeedRead<T> = { status: 'ok'; payload: T } | { status: 'absent' } | { status: 'failed'; error: unknown }

/** Indices consumed in one drain before the caller gets a turn. */
const MAX_DRAIN_PER_READ = 20
const MAX_TAIL_CONFIRM_STEPS = 64
// Backoff after a failed read; the last delay repeats.
const DEFAULT_PROBE_BACKOFF_MS = [5_000, 15_000, 30_000]
// Backoff after a 404: asking at the poll rate is what turns a not-yet-written index into a minute of 500s.
const DEFAULT_ABSENT_BACKOFF_MS = [2_000, 6_000, 12_000]
// Failed attempts before a drain spends a read looking past an index.
const LOOKAHEAD_AFTER_ATTEMPTS = 2

function probeKey(owner: string, index: bigint): string {
  return `${owner}:${index}`
}

/** Why an index did not yield a payload. Each is spaced on its own schedule. */
export type ProbeMiss = 'failed' | 'absent'

/** Tracks which indices did not read and when each is worth asking about again. */
export class FeedProbe {
  private readonly attempts = new Map<string, number>()
  private readonly absentAttempts = new Map<string, number>()
  private readonly retryAfter = new Map<string, number>()
  private readonly backoffMs: readonly number[]
  private readonly absentBackoffMs: readonly number[]

  constructor(
    backoffMs: readonly number[] = DEFAULT_PROBE_BACKOFF_MS,
    absentBackoffMs: readonly number[] = DEFAULT_ABSENT_BACKOFF_MS,
  ) {
    this.backoffMs = backoffMs
    this.absentBackoffMs = absentBackoffMs
  }

  ready(owner: string, index: bigint): boolean {
    const at = this.retryAfter.get(probeKey(owner, index))

    return at === undefined || Date.now() >= at
  }

  // Counted per kind: only failures may trigger a lookahead.
  defer(owner: string, index: bigint, miss: ProbeMiss = 'failed'): { attempts: number; waitMs: number } {
    const key = probeKey(owner, index)
    const counts = miss === 'absent' ? this.absentAttempts : this.attempts
    const schedule = miss === 'absent' ? this.absentBackoffMs : this.backoffMs
    const attempts = (counts.get(key) ?? 0) + 1
    const waitMs = schedule[Math.min(attempts - 1, schedule.length - 1)]

    counts.set(key, attempts)
    this.retryAfter.set(key, Date.now() + waitMs)

    return { attempts, waitMs }
  }

  clear(owner: string, index: bigint): void {
    const key = probeKey(owner, index)

    this.attempts.delete(key)
    this.absentAttempts.delete(key)
    this.retryAfter.delete(key)
  }
}

/** Reads forward from `from`; returns the newest payload and the index to resume at, never skipping an unread one. */
export async function drainFeed<T>(
  read: (index: bigint) => Promise<FeedRead<T>>,
  from: bigint,
  owner: string,
  probe: FeedProbe,
  label: string,
  onEntry?: (payload: T, index: bigint) => void,
): Promise<{ latest: T | null; next: bigint }> {
  let next = from < 0n ? 0n : from
  let latest: T | null = null

  for (let i = 0; i < MAX_DRAIN_PER_READ; i++) {
    if (!probe.ready(owner, next)) break

    const result = await read(next)

    if (result.status === 'absent') {
      probe.defer(owner, next, 'absent')

      break
    }

    if (result.status === 'ok') {
      probe.clear(owner, next)
      onEntry?.(result.payload, next)
      latest = result.payload
      next += 1n
    } else {
      const { attempts, waitMs } = probe.defer(owner, next)

      if (attempts < LOOKAHEAD_AFTER_ATTEMPTS) {
        logger.debug(`${label} index ${next} unreadable, retrying in ${waitMs}ms: ${String(result.error)}`)
        break
      }

      const beyond = await read(next + 1n)

      if (beyond.status !== 'ok') {
        logger.debug(`${label} index ${next} unreadable (attempt ${attempts}) and nothing reads past it — waiting`)
        break
      }

      logger.warn(`${label} index ${next} unreadable but index ${next + 1n} reads — skipping it`)
      probe.clear(owner, next)
      probe.clear(owner, next + 1n)
      onEntry?.(beyond.payload, next + 1n)
      latest = beyond.payload
      next += 2n
    }
  }

  return { latest, next }
}

/** Highest index in a feed, or `-1n`: Bee's head lookup, confirmed forward since it under-reports when loaded. */
export async function resolveFeedTail<T>(
  latest: () => Promise<bigint | null>,
  read: (index: bigint) => Promise<FeedRead<T>>,
  label: string,
): Promise<bigint> {
  const head = await latest()
  let tail = head ?? -1n

  for (let step = 0; step < MAX_TAIL_CONFIRM_STEPS; step++) {
    const next = tail + 1n
    const result = await read(next)

    if (result.status === 'absent') return tail

    if (result.status === 'ok') {
      tail = next
    } else {
      const beyond = await read(next + 1n)

      if (beyond.status === 'ok') {
        tail = next + 1n
      } else {
        // Unknown with nothing past it: count it as written, since an unused index beats overwriting a chunk.
        logger.debug(`${label} index ${next} unreadable while resolving the tail — treating it as written`)

        return next
      }
    }
  }

  logger.warn(`${label} feed ran ${MAX_TAIL_CONFIRM_STEPS} indices past the head Bee reported (${head})`)

  return tail
}
