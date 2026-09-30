import { DocTransportFactory } from './doc'

/** Configuration passed to the `SwarmDoc` constructor. */
export interface DocSettings {
  /** Identity of the local user. */
  user: {
    /** Identity key (hex, with or without 0x). */
    privateKey: string
    /** Display name shown to other peers via the transport's presence mechanism. */
    nickname: string
    /** Unique per tab, random by default. Persist it in `sessionStorage` so a reload rejoins as the same session. */
    sessionId?: string
  }
  /** Infrastructure and session parameters. */
  infra: {
    /** Bee node HTTP API URL (e.g. `"http://localhost:1633"`). */
    beeUrl: string
    /** Postage batch for every write. Required and must be usable on `beeUrl`; checked on `start()`. */
    stamp: string
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
