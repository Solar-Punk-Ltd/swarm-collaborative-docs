import { MerkleTree } from 'cafe-utility'
import { describe, expect, it } from 'vitest'

import { splitIntoChunks } from '../src/lib/storage/chunkTree'

// Sizes around every edge of Bee's splitter: one chunk, a full level of 128, one past it, a carried-up last chunk.
const SIZES = [1, 4095, 4096, 4097, 8192, 50_000, 127 * 4096, 128 * 4096, 128 * 4096 + 1, 129 * 4096 + 7, 259 * 4096]

// Pseudo-random, so no two leaves are alike.
function bytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 0x9e3779b9

  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }

  return out
}

describe('splitIntoChunks', () => {
  it.each(SIZES)('%i bytes: the root Bee computes, children before the root', async size => {
    const data = bytes(size)
    const chunks = splitIntoChunks(data)
    const root = chunks[chunks.length - 1]
    const expected = Buffer.from((await MerkleTree.root(data)).hash()).toString('hex')

    expect(root.address).toBe(expected)
    expect(root.span).toBe(size)
    expect(chunks.every(c => c.payload.length <= 4096)).toBe(true)
  })
})
