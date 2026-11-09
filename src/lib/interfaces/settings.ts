import { DocTransportFactory } from './doc'
import type { SwarmStorage } from './storage'

/** Configuration passed to the `SwarmDoc` constructor. */
export interface DocSettings {
  /** Identity of the local user. */
  user: {
    /**
     * Identity key (hex, with or without 0x). Needed with a Bee node (`infra.beeUrl`), where it owns this person's
     * feeds. Leave it out with `infra.storage` from `createFreedomStorage`: Freedom holds the key and signs.
     */
    privateKey?: string
    /** Display name shown to other peers via the transport's presence mechanism. */
    nickname: string
    /** Unique per tab, random by default. Persist it in `sessionStorage` so a reload rejoins as the same session. */
    sessionId?: string
    /**
     * Key (hex) that signs this tab's deltas. Default: derived from `privateKey` and `sessionId`, or random without a
     * `privateKey`. Persist a random one in `sessionStorage` with `sessionId` so a reload keeps the same session.
     */
    sessionKey?: string
  }
  /** Infrastructure and session parameters. */
  infra: {
    /** Bee node HTTP API URL (e.g. `"http://localhost:1633"`). Needed unless `storage` is given. */
    beeUrl?: string
    /**
     * Postage batch for every write through `beeUrl`, checked on `start()`. Omit it when `beeUrl` is a gateway that
     * attaches its own stamp. A failed check is reported as `DOC_ERROR` and does not stop the document.
     */
    stamp?: string
    /**
     * Where to read and write instead of `beeUrl`: `createFreedomStorage()` in Freedom Browser, or your own
     * `SwarmStorage`. Its `owner` is this person's identity in the room.
     */
    storage?: SwarmStorage
    /** Room secret. Whoever holds it can read and write the room. Mint one with `createRoomKey`. */
    roomKey: string
    /** Creator's identity from the invite; a head start for member discovery. */
    roomCreator?: string
    /** Identity address → username, used as display hints only. */
    members?: Map<string, string>
    /** `createSwarmRtcTransport` or `createSignalingServerTransport`. No default. */
    transport: DocTransportFactory
  }
}
