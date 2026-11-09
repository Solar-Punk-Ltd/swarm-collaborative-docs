import { Bee, Bytes } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import { gsocCoordinates } from '../src/lib/storage/gsoc'

const bee = new Bee('http://localhost')
const keccak = (s: string): Uint8Array => Bytes.keccak256(Bytes.fromUtf8(s)).toUint8Array()

describe('gsocCoordinates', () => {
  it('finds the key bee-js gsocMine finds from Freedom’s derivation', async () => {
    for (const topic of ['room:doc-42', `${'ab'.repeat(32)}:0`, `${'ab'.repeat(32)}:1`, `${'cd'.repeat(32)}:7`]) {
      const ours = await gsocCoordinates(topic)
      const theirs = bee.messaging.gsocMine(keccak(`freedom-gsoc-v1:${topic}`), keccak(topic), 12)

      expect(ours.signer.toHex()).toBe(theirs.toHex())
      expect(ours.identifier.toHex()).toBe(Bytes.keccak256(Bytes.fromUtf8(topic)).toHex())
      expect(ours.owner.toHex()).toBe(theirs.publicKey().address().toHex())
    }
  }, 120_000)

  it('mines a topic once', async () => {
    const topic = `${'ef'.repeat(32)}:3`
    const first = gsocCoordinates(topic)

    expect(gsocCoordinates(topic)).toBe(first)
    await first
  }, 60_000)
})
