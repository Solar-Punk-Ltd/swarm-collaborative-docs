import { PrivateKey, Topic } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import { createFreedomStorage, FreedomSwarmProvider } from '../src/lib'

import { freedomStandIn, memoryStore } from './freedomStandIn'

const key = new PrivateKey('11'.repeat(32))
const topic = Topic.fromString('swarmdoc-test-topic')
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

async function setup() {
  const store = memoryStore()
  const provider = freedomStandIn(store, key)
  const storage = await createFreedomStorage({ provider })

  return { store, provider, storage }
}

describe('createFreedomStorage', () => {
  it('owns its feeds with Freedom’s signing identity', async () => {
    const { storage } = await setup()

    expect(storage.owner).toBe(key.publicKey().address().toHex())
  })

  it('writes a feed entry that reads back at its index, and nothing at the next', async () => {
    const { storage } = await setup()

    await storage.writeFeed(topic, 0n, text('first'))
    await storage.writeFeed(topic, 1n, text('second'))

    const read = await storage.readFeed(topic, storage.owner, 1n)
    expect(read.status === 'ok' && new TextDecoder().decode(read.data)).toBe('second')
    expect((await storage.readFeed(topic, storage.owner, 2n)).status).toBe('absent')
  })

  it('writes a payload over one chunk as a chunk tree with its root, then the feed entry', async () => {
    const { storage, provider } = await setup()
    const data = new Uint8Array(50_000).map((_, i) => (i * 7) & 0xff)

    await storage.writeFeed(topic, 0n, data)

    const read = await storage.readFeed(topic, storage.owner, 0n)
    expect(read.status === 'ok' && Buffer.from(read.data).equals(Buffer.from(data))).toBe(true)
    // 13 leaves and the root, then the entry wrapping the root.
    expect(provider.calls.filter(c => c === 'swarm_publishChunk')).toHaveLength(14)
    expect(provider.calls.at(-2)).toBe('swarm_writeSingleOwnerChunk')
  })

  it('reads back a GSOC entry sent through Freedom at the address the library mines', async () => {
    const { storage } = await setup()
    const gsocTopic = `${'ab'.repeat(32)}:0`

    expect((await storage.readGsoc(gsocTopic)).status).toBe('absent')
    await storage.sendGsoc(gsocTopic, text('{"v":"v2","identities":["aa"]}'))

    const read = await storage.readGsoc(gsocTopic)
    expect(read.status === 'ok' && new TextDecoder().decode(read.data)).toBe('{"v":"v2","identities":["aa"]}')
  }, 60_000)

  it('reports an unknown failure as failed, never as absent', async () => {
    const provider: FreedomSwarmProvider = {
      request: ({ method }) => {
        if (method === 'swarm_getSigningIdentity') return Promise.resolve({ owner: key.publicKey().address().toHex() })

        if (method === 'swarm_requestAccess') return Promise.resolve({})

        return Promise.reject(Object.assign(new Error('Node not available'), { data: { reason: 'not-running' } }))
      },
    }
    const storage = await createFreedomStorage({ provider })

    expect((await storage.readFeed(topic, storage.owner, 0n)).status).toBe('failed')
    expect(await storage.feedHead(topic, storage.owner)).toBeNull()
  })
})
