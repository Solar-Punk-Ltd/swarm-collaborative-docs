import { Logger } from './logger'

/*
 * Shared index handling for the append-only feeds this library writes.
 *
 * Reading a feed means asking "is there an entry at index i?", and Bee answers that in a way that
 * is easy to misread. A chunk that was never written reads 404 only while retrieval still has peers
 * to ask; every failure puts a peer on a per-chunk skip list for a minute
 * (`pkg/retrieval/retrieval.go`, `errSkip`), and once they are all on it the same absent chunk
 * answers 500 instead, because `pkg/api/chunk.go` maps only `storage.ErrNotFound` to 404. Polling
 * the index a peer has not written yet therefore burns that address for a minute — including for
 * the moment the peer finally writes it.
 *
 * So a failed read means unknown: never present, never absent. The only positive evidence that an
 * index is genuinely stuck is a later index that reads. Stepping over one without that evidence
 * walks a reader past entries a peer has not written yet, which is how a WebRTC answer gets
 * discarded; counting it as present walks a tail resolution off the end of the feed.
 *
 * Writes must also never reuse an index: two payloads at one index are two single-owner chunks with
 * one address, which the node can then no longer serve. Where the two rules pull against each other
 * — resolving a feed's own tail — the tie goes to overshooting, which costs an unused index, rather
 * than undershooting, which destroys a chunk.
 */

const logger = Logger.getInstance()

/** Outcome of reading one feed index. `failed` is unknown, and is never treated as either of the others. */
export type FeedRead<T> = { status: 'ok'; payload: T } | { status: 'absent' } | { status: 'failed'; error: unknown }

/** Indices consumed in one drain before the caller gets a turn. */
const MAX_DRAIN_PER_READ = 20
const MAX_TAIL_CONFIRM_STEPS = 64
/*
 * A 500 says the node has given up on that address for about a minute, so asking again on the next
 * poll usually only adds load. The last delay repeats for as long as the index keeps failing.
 * Feeds whose next entry is being waited on — a signalling handshake — pass a shorter schedule:
 * there the wasted requests cost less than the delay in noticing the entry once it lands.
 */
const DEFAULT_PROBE_BACKOFF_MS = [5_000, 15_000, 30_000]
/*
 * Attempts before a drain spends an extra read proving that an index is stuck. The lookahead is
 * itself a read of a probably-absent chunk, so it is worth burning only once the index has failed
 * more than transiently.
 */
const LOOKAHEAD_AFTER_ATTEMPTS = 2

function probeKey(owner: string, index: bigint): string {
  return `${owner}:${index}`
}

/** Tracks which indices failed to read and when each is worth asking about again. */
export class FeedProbe {
  private readonly attempts = new Map<string, number>()
  private readonly retryAfter = new Map<string, number>()
  private readonly backoffMs: readonly number[]

  constructor(backoffMs: readonly number[] = DEFAULT_PROBE_BACKOFF_MS) {
    this.backoffMs = backoffMs
  }

  ready(owner: string, index: bigint): boolean {
    const at = this.retryAfter.get(probeKey(owner, index))

    return at === undefined || Date.now() >= at
  }

  /** Records a failure and returns how long this index is left alone for. */
  defer(owner: string, index: bigint): { attempts: number; waitMs: number } {
    const key = probeKey(owner, index)
    const attempts = (this.attempts.get(key) ?? 0) + 1
    const waitMs = this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)]

    this.attempts.set(key, attempts)
    this.retryAfter.set(key, Date.now() + waitMs)

    return { attempts, waitMs }
  }

  clear(owner: string, index: bigint): void {
    const key = probeKey(owner, index)

    this.attempts.delete(key)
    this.retryAfter.delete(key)
  }
}

/**
 * Reads forward from `from` and returns the newest payload found, with the index to resume at.
 *
 * Every feed here carries its full state in each entry, so only the newest readable one matters.
 * `next` moves only over indices that were actually read, which is what keeps a reader parked in
 * front of an index a peer has not written yet instead of marching past it.
 */
export async function drainFeed<T>(
  read: (index: bigint) => Promise<FeedRead<T>>,
  from: bigint,
  owner: string,
  probe: FeedProbe,
  label: string,
): Promise<{ latest: T | null; next: bigint }> {
  let next = from < 0n ? 0n : from
  let latest: T | null = null

  for (let i = 0; i < MAX_DRAIN_PER_READ; i++) {
    if (!probe.ready(owner, next)) break

    const result = await read(next)

    if (result.status === 'absent') break

    if (result.status === 'ok') {
      probe.clear(owner, next)
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
      latest = beyond.payload
      next += 2n
    }
  }

  return { latest, next }
}

/**
 * Highest index present in a feed, or `-1n` for an empty one.
 *
 * The search is Bee's: one unindexed lookup walks the feed node-side. That answer is then confirmed
 * forward, because Bee's sequential finder probes with a hardcoded one-second timeout and counts a
 * timeout as a miss (`pkg/feeds/sequence/sequence.go`), so on a loaded node it reports a head below
 * the real one — and a head reported too low is what makes a writer overwrite a live index. On a
 * feed nobody wrote since, the confirmation is a single extra read.
 *
 * @param latest Bee's own lookup for the feed head; `null` when the feed holds nothing.
 * @param read Reads one index, used to confirm the head and to walk past a stale one.
 */
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
        /*
         * Unknown, with nothing readable past it. Count it as written and stop: it may only be an
         * absent chunk the node has stopped looking for, in which case this costs one unused index,
         * where guessing the other way overwrites whatever is really there.
         */
        logger.debug(`${label} index ${next} unreadable while resolving the tail — treating it as written`)

        return next
      }
    }
  }

  logger.warn(`${label} feed ran ${MAX_TAIL_CONFIRM_STEPS} indices past the head Bee reported (${head})`)

  return tail
}
