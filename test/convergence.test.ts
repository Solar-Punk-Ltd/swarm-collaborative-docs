import { PrivateKey } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import { createFreedomStorage, createRoomKey, DOC_EVENTS, DocTransportFactory, MemberEntry, SwarmDoc } from '../src/lib'

import { ChunkStore, freedomStandIn, memoryStore } from './freedomStandIn'

// Feeds only: no channel ever opens, so every edit must travel through Swarm.
const noTransport: DocTransportFactory = () => ({
  start: () => undefined,
  stop: () => undefined,
  subscribe: () => undefined,
  publish: () => undefined,
  connectToPeer: () => undefined,
  isRemoteOrigin: () => false,
})

async function freedomDoc(store: ChunkStore, seed: string, roomKey: string, roomCreator?: string) {
  const storage = await createFreedomStorage({ provider: freedomStandIn(store, new PrivateKey(seed.repeat(32))) })
  const doc = new SwarmDoc({
    user: { nickname: seed },
    infra: { storage, roomKey, roomCreator, transport: noTransport },
  })

  return { doc, identity: storage.owner }
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms

  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

describe('two people on storage the page does not sign', () => {
  it('find each other through the GSOC directory and converge both ways, a snapshot over 4 KB included', async () => {
    const store = memoryStore()
    const roomKey = createRoomKey()
    const alice = await freedomDoc(store, 'a1', roomKey)
    // Bob does not know Alice: only the directory can introduce them.
    const bob = await freedomDoc(store, 'b2', roomKey)

    let aliceSees: ReadonlyMap<string, MemberEntry> = new Map()
    alice.doc.getEmitter().on(DOC_EVENTS.MEMBERS_UPDATED, (m: ReadonlyMap<string, MemberEntry>) => (aliceSees = m))

    try {
      alice.doc.start()
      alice.doc.doc.getText('t').insert(0, 'from alice. ')
      await alice.doc.flush()

      bob.doc.start()
      await until(() => bob.doc.doc.getText('t').toString().includes('from alice'), 60_000)

      const long = 'x'.repeat(6000)
      bob.doc.doc.getText('t').insert(0, `from bob ${long}. `)
      await bob.doc.flush()
      await until(() => alice.doc.doc.getText('t').toString().includes('from bob'), 60_000)

      expect(alice.doc.doc.getText('t').toString()).toBe(bob.doc.doc.getText('t').toString())
      // Each person's sessions are listed under their own identity.
      expect([...aliceSees.values()].map(m => m.identity)).toContain(bob.identity)
    } finally {
      alice.doc.stop()
      bob.doc.stop()
    }
  }, 150_000)
})
