import { PrivateKey } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import { createFreedomStorage, createRoomKey, DocTransportFactory, SwarmDoc } from '../src/lib'

import { beeStore, freedomStandIn } from './freedomStandIn'

/*
 * Live, on a Bee node: one person on bee-js (`beeUrl`, the page signs), one through a Freedom stand-in that writes
 * as Freedom does (direct uploads, Freedom's SOC and GSOC derivation) to the same node. Writes a few dozen chunks.
 *   BEE_URL=http://127.0.0.1:1633 BEE_STAMP=<immutable batch> pnpm test test/interop.live.test.ts
 */
const { BEE_URL, BEE_STAMP } = process.env

const noTransport: DocTransportFactory = () => ({
  start: () => undefined,
  stop: () => undefined,
  subscribe: () => undefined,
  publish: () => undefined,
  connectToPeer: () => undefined,
  isRemoteOrigin: () => false,
})

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms

  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const random = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

describe.skipIf(!BEE_URL || !BEE_STAMP)('a Bee client and a Freedom client in one room, live', () => {
  it('converge both ways, a snapshot over 4 KB included', async () => {
    const beeUrl = BEE_URL as string
    const stamp = BEE_STAMP as string
    const roomKey = createRoomKey()
    const aliceKey = random()
    const alice = new SwarmDoc({
      user: { privateKey: aliceKey, nickname: 'alice-bee' },
      infra: { beeUrl, stamp, roomKey, transport: noTransport },
    })
    const storage = await createFreedomStorage({
      provider: freedomStandIn(beeStore(beeUrl, stamp), new PrivateKey(random())),
    })
    // Bob opens Alice's invite: it names her identity as the creator.
    const aliceIdentity = new PrivateKey(aliceKey).publicKey().address().toHex()
    const bob = new SwarmDoc({
      user: { nickname: 'bob-freedom' },
      infra: { storage, roomKey, roomCreator: aliceIdentity, transport: noTransport },
    })
    const t0 = Date.now()
    const log = (msg: string): void => console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${msg}`)

    try {
      alice.start()
      alice.doc.getText('t').insert(0, 'from alice on bee-js. ')
      await alice.flush()
      log('alice wrote')

      bob.start()
      await until(() => bob.doc.getText('t').toString().includes('from alice'), 120_000)
      log('bob (Freedom) read alice')

      bob.doc.getText('t').insert(0, `from bob through Freedom ${'y'.repeat(6000)}. `)
      await bob.flush()
      log('bob wrote a 6 KB snapshot')
      await until(() => alice.doc.getText('t').toString().includes('from bob'), 120_000)
      log('alice (bee-js) read bob')

      expect(alice.doc.getText('t').toString()).toBe(bob.doc.getText('t').toString())
    } finally {
      alice.stop()
      bob.stop()
    }
  }, 300_000)
})
