import { DocTransportFactory } from './doc'

/** Configuration passed to the `SwarmDoc` constructor. */
export interface DocSettings {
  /** Identity of the local user. */
  user: {
    /** secp256k1 private key (hex, with or without 0x prefix). */
    privateKey: string
    /** Display name shown to other peers via the transport's presence mechanism. */
    nickname: string
    /**
     * Identifier for this editing session, unique per tab.
     *
     * The same identity may be open in several tabs or devices at once; each needs its own
     * session or they overwrite one another's Swarm feeds. Defaults to a random UUID per
     * `SwarmDoc` instance. Persist it in `sessionStorage` so a reload rejoins the same session
     * instead of leaving the previous one behind.
     */
    sessionId?: string
  }
  /** Infrastructure and session parameters. */
  infra: {
    /** Bee node HTTP API URL (e.g. `"http://localhost:1633"`). */
    beeUrl: string
    /**
     * Postage batch ID used for all Swarm writes: document snapshots, notification feed
     * entries, WebRTC signal records, and the consensus member list.
     *
     * Required. Every participant writes their own feed, so every participant needs a usable
     * batch on the node named by `beeUrl` — either a shared node that already owns one, or
     * their own node whose wallet holds xBZZ and xDAI to buy one. Validated against the node
     * during `start()`; an unusable batch raises `DOC_ERROR` instead of failing at first write.
     */
    stamp: string
    /** Shared room identifier. All peers in the same room must use the same `topic`. */
    topic: string
    /**
     * Pre-seeded peer identity addresses with usernames. Treated as display hints only —
     * a session's feeds are addressed by its session address, which is resolved from the
     * consensus member list or a `join` notification.
     */
    members?: Map<string, string>
    /**
     * Transport factory. Determines how peers discover one another and exchange updates.
     * There is no default: pick one and configure it explicitly.
     *
     *   - `createSwarmRtcTransport` — WebRTC signalled over Swarm feeds. No server to run;
     *     you supply `iceServers`.
     *   - `createSignalingServerTransport` — WebRTC signalled over a WebSocket server you
     *     operate; you supply `signalingUrl` and `iceServers`.
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
