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
import { SwarmDoc, DocSettings, DOC_EVENTS, createSwarmFeedTransport } from '@solarpunkltd/swarm-collaborative-docs'

const settings: DocSettings = {
  user: {
    privateKey: '0xabc...', // secp256k1 private key
    nickname: 'Alice',
  },
  infra: {
    beeUrl: 'http://localhost:1633',
    mutableStamp: 'your-mutable-batch-id',
    topic: 'my-room',
    transport: createSwarmFeedTransport(beeUrl, privateKey, mutableStamp, 'my-room'),
  },
}

const swarmDoc = new SwarmDoc(settings)

swarmDoc.getEmitter().on(DOC_EVENTS.DOC_UPDATED, doc => {
  /* re-render */
})
swarmDoc.getEmitter().on(DOC_EVENTS.MEMBERS_UPDATED, members => {
  /* update peer list */
})
swarmDoc.getEmitter().on(DOC_EVENTS.PEERS_CONNECTED, () => {
  /* enable editor */
})
swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR, err => {
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
    topic: string // shared room identifier
    members?: string[] // pre-seeded peer addresses
    transport: DocTransportFactory
  }
}
```

A single `mutableStamp` covers all writes: document snapshots, notification feed entries, WebRTC signal records, and the
consensus member list.

### `DOC_EVENTS`

| Event                        | Payload    | When                                      |
| ---------------------------- | ---------- | ----------------------------------------- |
| `DOC_EVENTS.DOC_UPDATED`     | `Y.Doc`    | After every remote update is applied      |
| `DOC_EVENTS.DOC_ERROR`       | `Error`    | Stamp validation failure or publish error |
| `DOC_EVENTS.MEMBERS_UPDATED` | `string[]` | Peer list changes                         |
| `DOC_EVENTS.PEERS_CONNECTED` | `true`     | Transport has at least one connected peer |

---

## Transports

Each transport implements `DocTransport` and is passed to `DocSettings.infra.transport` as a factory function.

### `createSwarmFeedTransport`

**Best for**: reliable delivery, offline peers, production use without a signaling server.

Polls each peer's `<topic>_notify<address>` Swarm feed at 1.5s intervals (backs off to 5s when idle). Writes outgoing
payloads to own notification feed.

```typescript
import { createSwarmFeedTransport } from '@solarpunkltd/swarm-collaborative-docs'

transport: createSwarmFeedTransport(beeUrl, privateKey, mutableStamp, topic)
```

**Delivery model**: store-and-forward over Swarm feeds. Messages persist for offline peers and are delivered on next
poll. Latency ~1.5–5s.

---

### `createYWebrtcTransport`

**Best for**: low-latency sync in controlled environments with an available signaling server.

Uses the [y-webrtc](https://github.com/yjs/y-webrtc) library. Peers are discovered via the `awareness` protocol through
a WebSocket signaling server. Y.js state is synchronised over WebRTC data channels. Cross-tab sync within the same
origin is handled automatically by y-webrtc's built-in BroadcastChannel — no separate `createBroadcastChannelTransport`
is needed.

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
deterministic (lower address = initiator) to avoid duplicate connections. On ICE failure, the initiator retries after
10s.

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

**Delivery model**: gossipsub pub/sub over Waku network. Near-real-time delivery for online peers. Messages are
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

| Returned value        | Type            | Description                                 |
| --------------------- | --------------- | ------------------------------------------- |
| `doc`                 | `Y.Doc \| null` | The Yjs document (null before init)         |
| `error`               | `Error \| null` | Latest error, or null                       |
| `members`             | `string[]`      | Current peer addresses                      |
| `connected`           | `boolean`       | Whether the transport has at least one peer |
| `refreshMemberList()` | `() => void`    | Triggers an immediate member list refresh   |
| `dismissError()`      | `() => void`    | Clears the current error                    |

---

## Example app (`src/app`)

A minimal test application demonstrating all transport options with a shared plain-text editor.

### Running locally

```bash
pnpm install
npm run start
```

The app runs at `http://localhost:5002`.

### Login screen

Configure before joining a session:

- **Bee URL** — your local Bee node API (e.g. `http://localhost:1633`)
- **Topic** — shared room name; all peers must use the same value
- **Mutable stamp** — postage batch for all Swarm writes
- **Transport selection**:
  - _Swarm_ — SwarmFeed polling (offline-tolerant, no extra server)
  - _y-webrtc_ — WebRTC via a WebSocket signaling URL
  - _Swarm WebRTC_ — WebRTC with Swarm-based SDP signaling (STUN URL required)
  - _Waku_ — Waku gossipsub network (optional bootstrap peer address)
- **Disable until connected** — prevents editing before the transport has a live peer

### Session screen

- Shared textarea bound to a Yjs `Text` type
- Peer list showing connected Ethereum addresses (short display + copy on click)
- Config panel for live mutable stamp and topic changes without re-login
- Transport badge showing the active transport

## Transport comparison

|                   | SwarmFeed | y-webrtc | SwarmRtc |  Waku  | BroadcastChannel |
| ----------------- | :-------: | :------: | :------: | :----: | :--------------: |
| Latency           |  ~1.5–5s  |  ~100ms  |  ~100ms  | ~100ms |       ~0ms       |
| Offline delivery  |     ✓     |    ✗     |    ✗     |   ✗    |        ✗         |
| No central server |     ✓     |    ✗     |    ✓     |   ✓    |        ✓         |
| Requires Bee node |     ✓     |    ✗     |    ✓     |   ✗    |        ✗         |
| Cross-device      |     ✓     |    ✓     |    ✓     |   ✓    |        ✗         |

All transports fall back to Swarm snapshot reads for document history recovery regardless of notification delivery
guarantees.
