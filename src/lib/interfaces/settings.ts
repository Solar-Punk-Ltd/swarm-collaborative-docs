import { DocTransportFactory } from './doc'

/** Configuration passed to the `SwarmDoc` constructor. */
export interface DocSettings {
  /** Identity of the local user. */
  user: {
    /** secp256k1 private key (hex, with or without 0x prefix). */
    privateKey: string
    /** Display name shown to other peers via the transport's presence mechanism. */
    nickname: string
  }
  /** Infrastructure and session parameters. */
  infra: {
    /** Bee node HTTP API URL (e.g. `"http://localhost:1633"`). */
    beeUrl: string
    /**
     * Postage batch ID used for all Swarm writes:
     * document snapshots, notification feed entries, WebRTC signal records, and the
     * consensus member list. Required for publishing document changes.
     * Falls back to a placeholder value when omitted (useful in test environments).
     */
    stamp?: string
    /** Shared room identifier. All peers in the same room must use the same `topic`. */
    topic: string
    /** Pre-seeded peer Ethereum addresses with usernames. Merged with the Swarm consensus member list at init. */
    members?: Map<string, string>
    /**
     * Transport factory. Determines how peers exchange notifications and sync state.
     * Built-in options: `createSwarmPubSubTransport`, `createSwarmRtcTransport`,
     * `createYWebrtcTransport`, `createWakuTransport`.
     */
    transport: DocTransportFactory
  }
}

/** Derived user state, computed once from `DocSettings.user.privateKey`. */
export interface UserSettings {
  privateKey: string
  /** Ethereum address corresponding to `privateKey`. */
  ownAddress: string
  nickname: string
  /** Last written doc-feed index for this session. */
  ownIndex: bigint
}
