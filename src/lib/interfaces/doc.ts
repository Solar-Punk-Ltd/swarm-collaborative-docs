import type { PrivateKey } from '@ethersphere/bee-js'
import * as Y from 'yjs'

import { EventEmitter } from '../utils/eventEmitter'

import { IMembers, MemberEntry } from './members'
import type { CursorPosition, NotificationHandler, NotificationPayload } from './notification'

/** Collaborative Yjs document: full snapshots on each session's Swarm feed, deltas to online peers. */
export interface ISwarmDoc {
  /** The underlying Yjs document. Bind editors directly to this instance. */
  readonly doc: Y.Doc

  /** Starts the transport, fetches peer snapshots, and begins the member-list poll. Call once after constructing. */
  start(): void

  /** Stops the transport, clears all timers, and destroys the Yjs document. */
  stop(): void

  /** Publishes queued local edits now and resolves once they are on Swarm. Call before the page unloads. */
  flush(): Promise<void>

  /** Sets the local cursor, broadcast on the next tick; `null` clears it. */
  updateCursor(cursor: CursorPosition): void

  /** Returns the event emitter. Subscribe to `DOC_EVENTS` constants for doc lifecycle events. */
  getEmitter(): EventEmitter

  /** Reads the room's member feeds now and registers newly discovered sessions. */
  refreshMemberList(): Promise<void>
}

/** How `SwarmDoc` reaches online peers; built by a `DocTransportFactory`. */
export interface DocTransport {
  /** Called once by `SwarmDoc.start()`. */
  start(): void
  /** Tear down the transport and release all resources. Called by `SwarmDoc.stop()`. */
  stop(): void
  /** Receives peer notifications through `handler`. */
  subscribe(topic: string, handler: NotificationHandler): void
  /** Sends a notification to connected peers. */
  publish(payload: NotificationPayload): void
  /** Called when a peer is registered; a transport may dial it. */
  connectToPeer(address: string): void
  /** `true` if this transport applied the update with this origin, so it is not re-published. */
  isRemoteOrigin(origin: unknown): boolean
}

/** Dependencies injected into a `DocTransport` by `SwarmDoc` via the factory. */
export interface DocTransportDeps {
  /** The shared Yjs document being synchronised. */
  doc: Y.Doc
  /** Event emitter for surfacing `DOC_EVENTS` to the application layer. */
  emitter: { emit(event: string, ...args: unknown[]): void }
  /** Accessor for the current peer set. */
  members: IMembers
  /** Session address of the local user (hex, no 0x prefix). Peers and feeds are keyed by this. */
  ownAddress: string
  /** Identity address of the local user (hex, no 0x prefix). Shared across that user's sessions. */
  ownIdentity: string
  /** Session identifier of the local user. */
  sessionId: string
  /** Display name of the local user. */
  nickname: string
  /** Called when the transport discovers a peer not yet in the member set. */
  onPeerDiscovered: (address: string, entry: MemberEntry) => void
  /** Prefix of the room's feed topics. Never send it to a server. */
  docFeedId: string
  /** Name to meet peers under on shared infrastructure, such as a signaling server. Reveals no feed address. */
  rendezvous: string
  /** Room-derived secret for encrypting signaling traffic. It must never leave the client. */
  transportSecret: string
  /** Bee node HTTP API URL. */
  beeApiUrl: string
  /** Session key that signs this session's feed writes. */
  signer: PrivateKey
  /** Postage batch ID for snapshot and signal writes. */
  stampId: string
}

/** Called once in the `SwarmDoc` constructor with resolved dependencies. Returns the transport instance. */
export type DocTransportFactory = (deps: DocTransportDeps) => DocTransport
