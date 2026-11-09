import { Bee } from '@ethersphere/bee-js'

/*
 * Data split into content-addressed chunks exactly as Bee's splitter does, so a tree built in the page has the root
 * a Bee node would compute. Needed where the only upload is one chunk at a time (Freedom's `swarm_publishChunk`).
 * Leaves hold 4096 bytes; an intermediate chunk holds up to 128 references. A level that ends with a single
 * reference passes it up unwrapped, as in Bee's hash trie.
 */

const CHUNK_SIZE = 4096
const BRANCHES = 128

/** One chunk of a tree: its payload, the length of all data under it, and its address (hex). */
export interface TreeChunk {
  payload: Uint8Array
  span: number
  address: string
}

// Only computes addresses; never connects.
const hasher = new Bee('http://localhost')

function chunk(payload: Uint8Array, span: number): TreeChunk {
  return { payload, span, address: hasher.makeContentAddressedChunk(payload, BigInt(span)).address.toHex() }
}

/** Every chunk of `data`'s tree, children before parents; the last one is the root. */
export function splitIntoChunks(data: Uint8Array): TreeChunk[] {
  const out: TreeChunk[] = []
  const levels: TreeChunk[][] = [[]]

  const push = (level: number, node: TreeChunk): void => {
    const refs = (levels[level] ??= [])
    refs.push(node)

    if (refs.length === BRANCHES) wrap(level)
  }
  const wrap = (level: number): void => {
    const refs = levels[level]
    levels[level] = []
    const payload = new Uint8Array(refs.length * 32)
    refs.forEach((r, i) => payload.set(hexBytes(r.address), i * 32))
    const parent = chunk(
      payload,
      refs.reduce((n, r) => n + r.span, 0),
    )
    out.push(parent)
    push(level + 1, parent)
  }

  let offset = 0

  do {
    const leaf = chunk(data.slice(offset, offset + CHUNK_SIZE), Math.min(CHUNK_SIZE, data.length - offset))
    out.push(leaf)
    push(0, leaf)
    offset += CHUNK_SIZE
  } while (offset < data.length)

  for (let level = 0; ; level++) {
    const refs = levels[level] ?? []
    const above = levels.slice(level + 1).some(l => l.length > 0)

    if (refs.length === 1 && !above) {
      // The root must come last; a carried-up chunk may have been emitted earlier.
      const root = refs[0]
      const at = out.lastIndexOf(root)

      if (at !== out.length - 1) out.push(out.splice(at, 1)[0])

      return out
    }

    if (refs.length === 1) {
      levels[level] = []
      push(level + 1, refs[0])
    } else if (refs.length > 1) {
      wrap(level)
    }
  }
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)

  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)

  return out
}
