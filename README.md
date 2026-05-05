# swarm-collaborative-docs

Serverless, real-time collaborative document editing over [Swarm](https://ethswarm.org).

Each peer writes [Yjs](https://docs.yjs.dev) CRDT snapshots to their own Swarm feed and broadcasts incremental deltas
via a pluggable transport. Late-joining peers recover full document history by fetching Swarm snapshots; online peers
receive low-latency delta notifications. No central server is required for either persistence or synchronisation.

---

## How it works

### Data layers

| Layer                  | Mechanism                                            | Purpose                                          |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| **Document snapshot**  | Per-user Swarm mutable feed (`<topic>_doc<address>`) | Durable, offline-accessible full state           |
| **Delta notification** | Transport-dependent (see below)                      | Fast sync for peers already online               |
| **Member discovery**   | Shared Swarm feed (`<topic>_members`)                | Persistent peer list without out-of-band sharing |
| **WebRTC signaling**   | Per-user Swarm mutable feed (`<topic>_signal`)       | SDP exchange without a signaling server          |

### Document lifecycle

1. **Init**: Each peer reads its own latest snapshot from Swarm and restores local Yjs state.
2. **Member list**: The peer writes itself to the shared consensus feed, then fetches snapshots from all listed peers.
3. **Join announcement**: A `NotificationPayload` with `feedIndex = JOIN_FEED_INDEX` (-1) is published so online peers
   know to fetch the new peer's snapshot.
4. **Local edits**: Yjs `update` events are debounced (500ms), merged into a snapshot, written to the user's Swarm feed,
   and broadcast as a delta via the transport.
5. **Remote updates (delta path)**: When a notification carrying a `delta` arrives, the base64-encoded Yjs update is
   applied directly — no Swarm read required.
6. **Remote updates (snapshot path)**: For join events or notifications without a delta, the peer's full snapshot is
   fetched from Swarm (with retries).

---

## Library API (`src/lib`)

### Installation

```bash
npm install @solarpunkltd/swarm-collaborative-docs
```

### `SwarmDoc`

The primary class. Manages a Yjs document backed by Swarm and a pluggable transport.

```typescript
import { SwarmDoc, DocSettings, DOC_EVENTS, createSwarmPubSubTransport } from '@solarpunkltd/swarm-collaborative-docs'

const settings: DocSettings = {
  user: {
    privateKey: '0xabc...', // secp256k1 private key
    nickname: 'Alice',
  },
  infra: {
    beeUrl: 'http://localhost:1633',
    mutableStamp: 'your-mutable-batch-id',
    topic: 'my-document-id',
    transport: createSwarmPubSubTransport('/ip4/1.2.3.4/tcp/1634/p2p/QmXxxx…'),
  },
}

const swarmDoc = new SwarmDoc(settings)

swarmDoc.getEmitter().on(DOC_EVENTS.DOC_UPDATED, (doc: Y.Doc) => {
  /* re-render */
})
swarmDoc.getEmitter().on(DOC_EVENTS.MEMBERS_UPDATED, (members: Map<string, string>) => {
  /* update peer list — Map<ethereumAddress, username> */
})
swarmDoc.getEmitter().on(DOC_EVENTS.PEERS_CONNECTED, () => {
  /* enable editor */
})
swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR, (err: Error) => {
  /* show error */
})

swarmDoc.start()

// access the Y.Doc directly
const text = swarmDoc.doc.getText('content')

// later
swarmDoc.stop()
```

#### Public members

| Member                | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `doc: Y.Doc`          | The shared Yjs document. Bind editors directly to this instance. |
| `start()`             | Starts transport, fetches snapshots, begins member poll.         |
| `stop()`              | Tears down transport and all timers.                             |
| `getEmitter()`        | Returns the `EventEmitter` for `DOC_EVENTS` subscriptions.       |
| `refreshMemberList()` | Force-reads the consensus member list and registers new peers.   |

### `DocSettings`

```typescript
interface DocSettings {
  user: {
    privateKey: string // secp256k1, hex with or without 0x
    nickname: string
  }
  infra: {
    beeUrl: string // e.g. "http://localhost:1633"
    mutableStamp?: string // mutable batch (immutableFlag=false) for all Swarm writes
    topic: string // shared document identifier (UUID recommended)
    members?: Map<string, string> // pre-seeded peers: Map<ethereumAddress, username>
    transport: DocTransportFactory
  }
}
```

A single `mutableStamp` covers all writes: document snapshots, notification feed entries, WebRTC signal records, and the
consensus member list.

### `DOC_EVENTS`

| Event                        | Payload               | When                                      |
| ---------------------------- | --------------------- | ----------------------------------------- |
| `DOC_EVENTS.DOC_UPDATED`     | `Y.Doc`               | After every remote update is applied      |
| `DOC_EVENTS.DOC_ERROR`       | `Error`               | Stamp validation failure or publish error |
| `DOC_EVENTS.MEMBERS_UPDATED` | `Map<string, string>` | Peer list changes (address → username)    |
| `DOC_EVENTS.PEERS_CONNECTED` | `true`                | Transport has at least one connected peer |

---

## Transports

Each transport implements `DocTransport` and is passed to `DocSettings.infra.transport` as a factory function.

### `createSwarmPubSubTransport`

**Best for**: low-latency real-time notifications over Swarm with no external signaling server.

Uses Swarm's GSOC ephemeral pubsub (via the Bee node WebSocket endpoint). All peers subscribed to the same document ID
connect to the same GSOC address — derived deterministically from the `docFeedId` using `PubsubMode.GSOC_EPHEMERAL`
(keccak256 hash → ephemeral key → SOC address). Publish calls are buffered while the WebSocket is connecting and drained
as soon as the connection opens. If the WebSocket closes unexpectedly, the transport reconnects automatically after 10
seconds.

Peer discovery does **not** happen at the transport level — new peers become visible via the consensus Swarm feed or
through incoming JOIN notifications.

```typescript
import { createSwarmPubSubTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createSwarmPubSubTransport('/ip4/1.2.3.4/tcp/1634/p2p/QmXxxx…')
```

The sole argument is the multiaddress of a Bee node that acts as the GSOC broker/relay.

**Delivery model**: bidirectional WebSocket push over the Swarm GSOC pubsub channel. Messages are ephemeral — offline
peers rely on Swarm snapshot reads for recovery. Low latency: ~100ms.

---

### `createSwarmFeedTransport`

**Best for**: reliable delivery to offline peers; production use without any external server.

Polls each peer's `<topic>_notify<address>` Swarm feed at 1.5 s intervals (backs off to 5 s when idle). Writes outgoing
payloads to the local user's own notification feed.

```typescript
import { createSwarmFeedTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createSwarmFeedTransport(beeUrl, privateKey, mutableStamp, topic)
```

**Delivery model**: store-and-forward over Swarm feeds. Messages persist for offline peers and are delivered on next
poll. Latency ~1.5–5 s.

---

### `createYWebrtcTransport`

**Best for**: low-latency sync in controlled environments with an available WebSocket signaling server.

Uses the [y-webrtc](https://github.com/yjs/y-webrtc) library. Peers are discovered via the `awareness` protocol through
a WebSocket signaling server. Yjs state is synchronised over WebRTC data channels. Cross-tab sync within the same origin
is handled automatically by y-webrtc's built-in BroadcastChannel — no separate `createBroadcastChannelTransport` is
needed.

```typescript
import { createYWebrtcTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createYWebrtcTransport('wss://your-signaling-server.example' /* iceServers? */)
```

**Delivery model**: WebRTC data channels (peer-to-peer). `subscribe`/`publish` are no-ops; Yjs updates flow directly
over data channels. Swarm snapshot reads still provide fallback for offline history.

---

### `createSwarmRtcTransport`

**Best for**: peer-to-peer sync without any central server (fully decentralised).

SDP offer/answer records are written to and read from each peer's `<topic>_signal` Swarm mutable feed, replacing the
traditional signaling server. ICE gathering runs to completion before the SDP is uploaded. Role assignment is
deterministic (lower address = initiator) to avoid duplicate connections. On ICE failure, the initiator retries after 10
s.

```typescript
import { createSwarmRtcTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createSwarmRtcTransport('stun:stun.l.google.com:19302' /* iceServers? */)
```

**Delivery model**: WebRTC data channels (peer-to-peer). `subscribe`/`publish` are no-ops. To handle join announcements
and snapshot hints for peers that go offline, compose this with a notification transport at the application layer.

---

### `createWakuTransport`

**Best for**: decentralised real-time notifications without a central server or Bee node dependency.

Connects to the [Waku](https://waku.org) network via a libp2p light node using LightPush (send) and Filter (receive)
protocols. Payloads are JSON-encoded `NotificationPayload` objects published to a content topic derived from the doc
topic. Node initialisation is asynchronous; calls made before the node is ready are buffered and drained automatically.

```typescript
import { createWakuTransport } from '@solarpunkltd/swarm-collaborative-docs'

// Uses Waku default bootstrap network:
transport: createWakuTransport()

// Or with explicit bootstrap peers:
transport: createWakuTransport(['/ip4/...'])
```

**Delivery model**: gossipsub pub/sub over the Waku network. Near-real-time delivery for online peers. Messages are
ephemeral — offline peers rely on Swarm snapshot reads for recovery.

---

### `createBroadcastChannelTransport`

**Best for**: same-origin multi-tab development and testing only.

Uses the browser `BroadcastChannel` API. Messages are visible only within the same origin (protocol + host + port). Does
not cross network boundaries.

```typescript
import { createBroadcastChannelTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createBroadcastChannelTransport()
```

---

## React hook (`useSwarmDoc`)

Convenience hook for React applications. Manages the `SwarmDoc` lifecycle, re-renders on events, and cleans up on
unmount.

```typescript
import { useSwarmDoc } from './hooks/useSwarmDoc'

const { doc, error, members, connected, refreshMemberList, dismissError } = useSwarmDoc({
  user: { privateKey, nickname },
  infra: { beeUrl, mutableStamp, topic, transport },
})
```

| Returned value        | Type                          | Description                                 |
| --------------------- | ----------------------------- | ------------------------------------------- |
| `doc`                 | `Y.Doc \| null`               | The Yjs document (null before init)         |
| `error`               | `Error \| null`               | Latest error, or null                       |
| `members`             | `Map<string, string> \| null` | Connected peers: address → username         |
| `connected`           | `boolean`                     | Whether the transport has at least one peer |
| `refreshMemberList()` | `() => void`                  | Triggers an immediate member list refresh   |
| `dismissError()`      | `() => void`                  | Clears the current error                    |

---

## Example app (`src/app`)

A minimal test application demonstrating all transport options with a shared text editor.

### Running locally

```bash
pnpm install
pnpm start
```

The app runs at `http://localhost:5002`.

### Login screen

Enter a username, then configure:

- **Document ID** — UUID that identifies the shared document; auto-generated and persisted in `localStorage`. Paste an
  invite link to pre-fill this field.
  - **Invite** button — copies a shareable link (`?doc=<id>&trans=<transport>`) to the clipboard.
  - **Generate new ID** — creates a fresh UUID and saves it.
- **Transport tabs** — select the active notification transport:
  - _Swarm PubSub_ — GSOC ephemeral pubsub (requires a Bee broker peer, see Advanced Settings)
  - _Waku_ — Waku gossipsub (no Bee node required)
  - _WebRTC_ — y-webrtc via a signaling server or Swarm-based SDP signaling (see Advanced Settings)
- **Advanced Settings** (collapsible):
  - Bee API URL
  - `MUTABLE_STAMP` postage batch ID
  - Disable editing until a peer is connected (WebRTC / Waku only)
  - Broker Peer multiaddress (Swarm PubSub only)
  - Signaling Server URL or Swarm Signaling STUN URL (WebRTC only)

### Session screen

- Shared editor bound to a Yjs `Text` type
- Peer list showing connected members with their usernames (hover for full address, click to copy)
- Transport badge showing the active transport

## Transport comparison

|                      | SwarmPubSub | SwarmFeed | y-webrtc | SwarmRtc |  Waku  | BroadcastChannel |
| -------------------- | :---------: | :-------: | :------: | :------: | :----: | :--------------: |
| Latency              |   ~100ms    |  ~1.5–5s  |  ~100ms  |  ~100ms  | ~100ms |       ~0ms       |
| Offline delivery     |      ✗      |     ✓     |    ✗     |    ✗     |   ✗    |        ✗         |
| No external server   |      ✓      |     ✓     |    ✗     |    ✓     |   ✓    |        ✓         |
| Requires Bee node    |      ✓      |     ✓     |    ✗     |    ✓     |   ✗    |        ✗         |
| Requires broker peer |      ✓      |     ✗     |    ✗     |    ✗     |   ✗    |        ✗         |
| Cross-device         |      ✓      |     ✓     |    ✓     |    ✓     |   ✓    |        ✗         |

All transports fall back to Swarm snapshot reads for document history recovery regardless of notification delivery
guarantees.
