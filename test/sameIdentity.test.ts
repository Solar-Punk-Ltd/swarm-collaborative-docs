import { PrivateKey } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import { createFreedomStorage, createRoomKey, DocTransportFactory, SwarmDoc } from '../src/lib'

import { freedomStandIn, memoryStore } from './freedomStandIn'

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
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

// In Freedom every tab of a site is the same identity; with a Bee node, every tab that loads the same key.
describe('one person in two tabs', () => {
  it('a new tab reads what an earlier tab of the same identity wrote', async () => {
    const store = memoryStore()
    const roomKey = createRoomKey()
    const key = new PrivateKey('c3'.repeat(32))
    const open = async (nickname: string) =>
      new SwarmDoc({
        user: { nickname },
        infra: {
          storage: await createFreedomStorage({ provider: freedomStandIn(store, key) }),
          roomKey,
          transport: noTransport,
        },
      })

    const first = await open('tab one')
    first.start()
    first.doc.getText('t').insert(0, 'written in the first tab')
    await first.flush()
    first.stop()

    const second = await open('tab two')

    try {
      second.start()
      await until(() => second.doc.getText('t').toString().includes('first tab'), 60_000)
      expect(second.doc.getText('t').toString()).toBe('written in the first tab')
    } finally {
      second.stop()
    }
  }, 90_000)
})
