import { Bee, Bytes, EthAddress, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js'

import type { FreedomSwarmProvider } from '../src/lib'

/*
 * A stand-in for Freedom Browser's `window.swarm`, doing what Freedom's handlers do (freedom-browser
 * src/main/swarm/chunk-service.js, feed-service.js, messaging-service.js) with bee-js, over memory or a Bee node.
 * It mines GSOC keys with bee-js's own `gsocMine`, independently of the library's miner.
 */

const bee = new Bee('http://localhost')
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

/** Where the stand-in keeps chunks: raw bytes (span ‖ payload, or a SOC) by address. */
export interface ChunkStore {
  putCac(address: string, data: Uint8Array): Promise<void>
  putSoc(owner: string, identifier: string, signature: string, body: Uint8Array): Promise<void>
  get(address: string): Promise<Uint8Array | null>
}

export function memoryStore(): ChunkStore & { chunks: Map<string, Uint8Array> } {
  const chunks = new Map<string, Uint8Array>()

  return {
    chunks,
    putCac: (address, data) => {
      chunks.set(address, data)

      return Promise.resolve()
    },
    putSoc: (owner, identifier, signature, body) => {
      const address = hex(
        bee.calculateSingleOwnerChunkAddress(new Identifier(identifier), new EthAddress(owner)).toUint8Array(),
      )
      const sig = new Uint8Array(Buffer.from(signature, 'hex'))
      const id = new Uint8Array(Buffer.from(identifier, 'hex'))
      chunks.set(address, new Uint8Array([...id, ...sig, ...body]))

      return Promise.resolve()
    },
    get: address => Promise.resolve(chunks.get(address) ?? null),
  }
}

/** Chunks on a Bee node, uploaded as Freedom uploads them (direct, pinned). */
export function beeStore(beeUrl: string, stamp: string): ChunkStore {
  const headers = {
    'content-type': 'application/octet-stream',
    'swarm-postage-batch-id': stamp,
    'swarm-deferred-upload': 'false',
  }

  return {
    putCac: async (_address, data) => {
      const r = await globalThis.fetch(`${beeUrl}/chunks`, { method: 'POST', headers, body: data })

      if (!r.ok) throw new Error(`chunk upload ${r.status}`)
    },
    putSoc: async (owner, identifier, signature, body) => {
      const r = await globalThis.fetch(`${beeUrl}/soc/${owner}/${identifier}?sig=${signature}`, {
        method: 'POST',
        headers,
        body,
      })

      if (!r.ok) throw new Error(`SOC upload ${r.status} ${await r.text()}`)
    },
    get: async address => {
      const r = await globalThis.fetch(`${beeUrl}/chunks/${address}`)

      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
    },
  }
}

class ProviderError extends Error {
  constructor(
    message: string,
    public readonly data: { reason: string },
  ) {
    super(message)
  }
}

/** A provider signing with `key`, over `store`. `calls` records every method called. */
export function freedomStandIn(store: ChunkStore, key: PrivateKey): FreedomSwarmProvider & { calls: string[] } {
  const owner = hex(key.publicKey().address().toUint8Array())
  const calls: string[] = []

  const writeSoc = async (signer: PrivateKey, identifier: string, data: Uint8Array, span?: number): Promise<string> => {
    const cac = bee.makeContentAddressedChunk(data, span === undefined ? undefined : BigInt(span))
    const soc = cac.toSingleOwnerChunk(new Identifier(identifier), signer)
    const body = new Uint8Array([...cac.span.toUint8Array(), ...cac.payload.toUint8Array()])
    await store.putSoc(hex(soc.owner.toUint8Array()), soc.identifier.toHex(), soc.signature.toHex(), body)

    return hex(soc.address.toUint8Array())
  }
  const readSoc = async (address: string): Promise<{ payload: Uint8Array; span: bigint }> => {
    const raw = await store.get(address)

    if (!raw) throw new ProviderError('Single Owner Chunk not found', { reason: 'chunk_not_found' })
    const soc = bee.unmarshalSingleOwnerChunk(raw, address)

    return { payload: soc.payload.toUint8Array(), span: soc.span.toBigInt() }
  }
  // Bee's joiner, enough for a tree: intermediate chunks hold 32-byte references.
  const join = async (address: string): Promise<Uint8Array> => {
    const raw = await store.get(address)

    if (!raw) throw new Error(`missing chunk ${address}`)
    const span = Number(new DataView(raw.buffer, raw.byteOffset).getBigUint64(0, true))
    const payload = raw.slice(8)

    if (span <= 4096) return payload.slice(0, span)
    const parts: Uint8Array[] = []
    for (let i = 0; i < payload.length; i += 32) parts.push(await join(hex(payload.slice(i, i + 32))))

    return new Uint8Array(parts.flatMap(p => [...p]))
  }
  const gsocSigner = (topic: string): { identifier: string; signer: PrivateKey } => {
    const identifier = Bytes.keccak256(Bytes.fromUtf8(topic)).toUint8Array()
    const target = Bytes.keccak256(Bytes.fromUtf8('freedom-gsoc-v1:' + topic)).toUint8Array()

    return { identifier: hex(identifier), signer: bee.messaging.gsocMine(target, identifier, 12) }
  }

  const methods: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    swarm_requestAccess: () => Promise.resolve({ connected: true }),
    swarm_getCapabilities: () => Promise.resolve({ canPublish: true, reason: null }),
    swarm_getSigningIdentity: () => Promise.resolve({ owner: '0x' + owner, identityMode: 'app-scoped' }),
    swarm_writeSingleOwnerChunk: async p => ({
      reference: await writeSoc(key, p.identifier as string, p.data as Uint8Array, p.span as number | undefined),
    }),
    swarm_publishChunk: async p => {
      const cac = bee.makeContentAddressedChunk(
        p.data as Uint8Array,
        p.span === undefined ? undefined : BigInt(p.span as number),
      )
      await store.putCac(cac.address.toHex(), cac.data)

      return { reference: cac.address.toHex() }
    },
    swarm_readFeedEntry: async p => {
      const topic = new Topic(p.topic as string)
      const index = p.index as number
      const id = Bytes.keccak256(new Uint8Array([...topic.toUint8Array(), ...uint64be(index)]))
      const address = hex(
        bee.calculateSingleOwnerChunkAddress(new Identifier(id), new EthAddress(p.owner as string)).toUint8Array(),
      )
      let soc
      try {
        soc = await readSoc(address)
      } catch {
        throw new ProviderError(`Feed entry not found at index ${index}`, { reason: 'entry_not_found' })
      }
      const cac = bee.makeContentAddressedChunk(soc.payload, soc.span)
      const data = soc.span <= 4096n ? soc.payload : await join(cac.address.toHex())

      return { data: b64(data), encoding: 'base64', index, nextIndex: index + 1 }
    },
    swarm_readSingleOwnerChunk: async p => {
      const address = hex(
        bee
          .calculateSingleOwnerChunkAddress(new Identifier(p.identifier as string), new EthAddress(p.owner as string))
          .toUint8Array(),
      )

      return { data: b64((await readSoc(address)).payload), encoding: 'base64' }
    },
    swarm_sendGsoc: async p => {
      const { identifier, signer } = gsocSigner(p.topic as string)
      const data = typeof p.data === 'string' ? new TextEncoder().encode(p.data) : (p.data as Uint8Array)

      return { sent: true, address: await writeSoc(signer, identifier, data) }
    },
  }

  return {
    calls,
    async request({ method, params }) {
      calls.push(method)
      const handler = methods[method]

      if (!handler) throw new ProviderError(`Unknown method: ${method}`, { reason: 'unsupported' })

      return await handler(params ?? {})
    },
  }
}

function uint64be(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)

  return out
}

export { b64, fromB64 }
