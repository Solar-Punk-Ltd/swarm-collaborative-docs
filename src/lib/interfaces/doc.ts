import type { PrivateKey } from '@ethersphere/bee-js'
import * as Y from 'yjs'

import { EventEmitter } from '../utils/eventEmitter'

import type { NotificationHandler, NotificationPayload } from './notification'

/**
 * Collaborative Yjs document backed by Swarm persistent storage.
 *
 * Each peer writes full Yjs state snapshots to their own per-user Swarm feed and
 * broadcasts incremental deltas to online peers via the configured `DocTransport`.
 * On startup, snapshots from all known peers are fetched and merged, so late-joining
 * peers converge to the same state without any central server.
 *
 */
export interface ISwarmDoc {
  /** The underlying Yjs document. Bind editors directly to this instance. */
  readonly doc: Y.Doc

  /** Starts the transport, fetches peer snapshots, and begins the member-list poll. Call once after constructing. */
  start(): void

  /** Stops the transport, clears all timers, and destroys the Yjs document. */
  stop(): void

  /**
   * Updates the local cursor position and schedules a broadcast.
   * Call from the editor's selection-change handler.
   * @param cursor Character index offsets `{ anchor, head }`, or `null` to clear.
   */
  updateCursor(cursor: { anchor: number; head: number } | null): void

  /** Returns the event emitter. Subscribe to `DOC_EVENTS` constants for doc lifecycle events. */
  getEmitter(): EventEmitter

  /** Reads the Swarm consensus member list and registers any newly discovered peers. */
  refreshMemberList(): Promise<void>
}

/**
 * Transport interface consumed by `SwarmDoc`. Implementations:
 *   - `createSwarmPubSubTransport` — Swarm GSOC pubsub WebSocket
 *   - `createSwarmRtcTransport` — WebRTC with Swarm-stored SDP signaling
 *   - `createYWebrtcTransport` — WebRTC via y-webrtc signaling server
 *   - `createWakuTransport` — libp2p gossipsub via Waku light node
 */
export interface DocTransport {
  /** Called once by `SwarmDoc.start()`. */
  start(): void
  /** Tear down the transport and release all resources. Called by `SwarmDoc.stop()`. */
  stop(): void
  /** Begin receiving notifications, invoking `handler` on each message. No-op on WebRTC-only transports. */
  subscribe(topic: string, handler: NotificationHandler): void
  /** Publish an outgoing notification. No-op on WebRTC-only transports. */
  publish(payload: NotificationPayload): void
  /**
   * Called when a peer is registered. WebRTC transports use this to initiate connections;
   * pub/sub transports treat it as a no-op.
   */
  connectToPeer(address: string): void
  /**
   * Returns `true` if the Yjs update `origin` was applied by this transport.
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
  /** Accessor for the current peer set. */
  members: {
    /** Returns all registered peers (address → username). */
    all(): ReadonlyMap<string, string>
    /** Returns `true` if `address` is in the registered set. */
    has(address: string): boolean
  }
  /** Ethereum address of the local user (hex, no 0x prefix). */
  ownAddress: string
  /** Display name of the local user. */
  nickname: string
  /** Called when the transport discovers a peer not yet in the member set. */
  onPeerDiscovered: (address: string, username: string) => void
  /** Topic namespace used to derive per-user Swarm feed identifiers. */
  docFeedId: string
  /** Bee node HTTP API URL. */
  beeApiUrl: string
  /** secp256k1 private key for signing Swarm feed writes. */
  signer: PrivateKey
  /** Mutable postage batch ID for snapshot and signal writes. */
  mutableStampId: string
}

/** Called once in the `SwarmDoc` constructor with resolved dependencies. Returns the transport instance. */
export type DocTransportFactory = (deps: DocTransportDeps) => DocTransport
