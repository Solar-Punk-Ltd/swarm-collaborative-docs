import type { PrivateKey } from '@ethersphere/bee-js'
import * as Y from 'yjs'

import type { NotificationHandler, NotificationPayload } from './notification'

/**
 * Unified transport interface consumed by `SwarmDoc`.
 *
 * Combines notification delivery (subscribe/publish) with peer connection management.
 * Built-in implementations:
 *   - `createSwarmFeedTransport` — polling over Swarm mutable feeds
 *   - `createBroadcastChannelTransport` — same-origin tab broadcast (dev/testing)
 *   - `createYWebrtcTransport` — WebRTC via y-webrtc signaling server
 *   - `createSwarmRtcTransport` — WebRTC with Swarm-stored SDP signaling
 *   - `createWakuTransport` — libp2p gossipsub via Waku light node
 */
export interface DocTransport {
  /** Initialise the transport. Called once by `SwarmDoc.start()`. */
  start(): void
  /** Tear down the transport and release all resources. Called by `SwarmDoc.stop()`. */
  stop(): void
  /** Begin receiving notifications for `topic`, invoking `handler` on each message. */
  subscribe(topic: string, handler: NotificationHandler): void
  /** Publish an outgoing notification. No-op on WebRTC-only transports. */
  publish(payload: NotificationPayload): void
  /**
   * Called when a peer is registered. Transports that manage direct connections
   * (WebRTC) use this to initiate them; others may treat it as a no-op.
   * @param address Ethereum address of the peer (hex, no 0x prefix).
   */
  connectToPeer(address: string): void
  /**
   * Returns `true` if the given Yjs update `origin` was applied by this transport.
   * Prevents re-broadcasting updates that arrived from a remote peer.
   */
  isRemoteOrigin(origin: unknown): boolean
}

/** Dependencies injected into a `DocTransport` by `SwarmDoc` via the factory. */
export interface DocTransportDeps {
  /** The shared Yjs document being synchronised. */
  doc: Y.Doc
  /** Event emitter for surfacing `DOC_EVENTS` to the application layer. */
  emitter: { emit(event: string, ...args: unknown[]): void }
  /** Read-only accessor for the current peer set and per-peer feed index state. */
  members: {
    /** Returns all registered peer addresses. */
    all(): string[]
    /** Returns `true` if `address` is in the registered set. */
    has(address: string): boolean
    /** Returns the last Swarm feed index applied from `address`, or `-1n` if none. */
    lastIndex(address: string): bigint
    /** Records the latest applied feed index for `address`. */
    setIndex(address: string, index: bigint): void
  }
  /** Ethereum address of the local user (hex, no 0x prefix). */
  ownAddress: string
  /** Display name of the local user. */
  nickname: string
  /**
   * Called when the transport discovers a peer not yet in the member set.
   * The transport should invoke this on awareness events or similar peer-discovery signals.
   */
  onPeerDiscovered: (address: string) => void
  /** Topic namespace used to derive per-user Swarm feed identifiers. Swarm transports only. */
  docFeedId: string
  /** Bee node HTTP API URL. Swarm transports only. */
  beeApiUrl: string
  /** secp256k1 private key for signing Swarm feed writes. Swarm transports only. */
  signer: PrivateKey
  /** Mutable postage batch ID for snapshot and signal writes. Swarm transports only. */
  mutableStampId: string
}

/**
 * Factory function signature. Called once in the `SwarmDoc` constructor with
 * fully resolved dependencies. Returns the `DocTransport` instance to use.
 */
export type DocTransportFactory = (deps: DocTransportDeps) => DocTransport
