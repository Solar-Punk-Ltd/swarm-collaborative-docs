# Phase 5 — Yjs Real-Time Transport (y-webrtc + y-websocket)

## Context prompt (for future AI sessions)

> This is a collaborative document editing library built on Ethereum Swarm + Yjs. Users write to per-user Swarm feeds
> (cold storage). A members feed stores Ethereum addresses for cold-start discovery. The original user question that
> produced this plan:
>
> y-webrtc suits my solution better. I want collaborative document editing eventually stored on Swarm. I have two
> implementations: BroadcastChannel (same tab only) and Swarm feed polling (slow, inefficient). A central gateway
> connects to the Swarm Bee node(s) used as cold storage. Each user entering the doc can discover others from the member
> list. Can y-webrtc utilize these addresses to deliver doc deltas and chunks? If the y-websocket server lives on the
> gateway (localhost for now), can peers subscribe to it and save their state like now? Analyze deeply and suggest."\_

---

## Problem

`SwarmFeedNotificationProvider` polls Swarm every 1.5–5 s per peer: slow, burns postage stamps on notification feeds,
requires every peer to manage per-address polling. `BroadcastChannelNotificationProvider` only works within the same
browser.

## Solution

Replace the entire `NotificationProvider` layer with `y-webrtc` (P2P) and optionally `y-websocket` (gateway relay). Both
providers attach directly to the `Y.Doc` and speak the Yjs Sync Step 1/2 protocol — real-time delta propagation to
online peers with zero polling. Swarm feeds remain unchanged as cold storage.

### What changes

| Before                                                 | After                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `SwarmFeedNotificationProvider` (polling, ~1.5 s)      | `y-webrtc` (WebRTC data channels, <100 ms)                    |
| `BroadcastChannelNotificationProvider` (same tab only) | `y-webrtc` built-in BroadcastChannel                          |
| `JOIN_FEED_INDEX = -1` sentinel                        | `awareness.setLocalStateField('user', { address, nickname })` |
| `addMember` / `startFetchProcess`                      | `awareness.on('change')` → cold-start Swarm fetch             |
| Swarm notification feed (`_notify`)                    | **deleted** — no longer written or polled                     |

### What does NOT change

Swarm doc feeds (full snapshots per user), Swarm members feed (address array for cold-start discovery), `Members` class,
`applyYjsBytes`, `fetchSnapshot`, `initMemberList`, `startMemberListPoll`, `validateStamps`, all Yjs CRDT logic.

### Answer to "Can y-webrtc use P2P addresses from the member list?"

No — `y-webrtc` discovers peers exclusively through the signaling server (pub/sub relay), not via direct Ethereum/Swarm
addresses. The members list retains its cold-start role: read from Swarm when joining with no online peers present. The
two discovery mechanisms are complementary, not overlapping.

### Answer to "Can the gateway y-websocket server act as relay and persistence?"

Yes, with caveats:

- `npx y-websocket` is a **pure relay by default** (stateless, no disk persistence).
- Swarm **remains** the persistence layer — y-websocket is valuable as an always-online relay peer for NAT traversal,
  not as a Swarm replacement.
- If the gateway runs the Bee node it can co-host both servers: signaling on `ws://gateway:4444`, y-websocket relay on
  `ws://gateway:1234`.

---

## Architecture After Migration

```
[Real-time online peers]  ←→  y-webrtc  (WebRTC data channels, P2P)
                          ←→  y-websocket  (gateway relay, NAT fallback, optional)

[Cold storage / offline]  ←→  Swarm doc feeds  (full Y.Doc snapshots, one per user)
                          ←→  Swarm members feed  (Ethereum addresses, cold-start)

[Awareness (ephemeral)]   ←→  { address: string, nickname: string } per peer
                               replaces JOIN_FEED_INDEX sentinel
```

The gateway (which runs the Bee node) can also run:

- `node node_modules/y-webrtc/bin/server.cjs` — signaling server (stateless pub/sub relay)
- `npx y-websocket` — WebSocket relay (optional NAT fallback)

---

## Implementation Plan

Each step must compile and type-check before the next.

### Step 1 — Install packages

```sh
pnpm add y-webrtc y-websocket
```

---

### Step 2 — Extend `DocSettings`, make `notificationProvider` optional

**File:** `src/lib/interfaces/settings.ts`

```typescript
import { NotificationProvider } from './notification' // keep temporarily

export interface DocSettings {
  user: { privateKey: string; nickname: string }
  infra: {
    beeUrl: string
    stamp?: string
    mutableStamp?: string
    topic: string
    members?: string[]
    signalingUrls?: string[] // y-webrtc signaling server(s), e.g. ['ws://localhost:4444']
    webSocketUrl?: string // y-websocket relay (optional NAT fallback)
    iceServers?: RTCIceServer[] // custom STUN/TURN; RTCIceServer is a DOM type, no import needed
  }
  notificationProvider?: NotificationProvider // optional during transition, removed in Step 8
}
```

---

### Step 3 — Rework `doc.ts`

**File:** `src/lib/doc/doc.ts`

**New imports:**

```typescript
import { WebrtcProvider } from 'y-webrtc'
import { WebsocketProvider } from 'y-websocket'
```

**New fields** (replace `notificationProvider: NotificationProvider`):

```typescript
private settings: DocSettings
private nickname: string
private rtcProvider: WebrtcProvider | null = null
private wsProvider: WebsocketProvider | null = null
private notificationProvider?: NotificationProvider  // legacy fallback only
```

**`isRemoteOrigin` helper** — new private method:

```typescript
private isRemoteOrigin(origin: unknown): boolean {
  return origin === 'remote' || origin === this.rtcProvider || origin === this.wsProvider
}
```

Replace the existing `if (origin === 'remote') return` in `doc.on('update')` with
`if (this.isRemoteOrigin(origin)) return`.

> **Rationale:** y-webrtc sets `origin` to the provider instance, not the string `'remote'`. Without this guard, every
> remote peer's update triggers a redundant Swarm write.

**`start()` — new provider creation block at the top:**

```typescript
public start(): void {
  const room = this.docFeedId  // topic + '_doc' — stable room name

  if (this.settings.infra.signalingUrls?.length) {
    this.rtcProvider = new WebrtcProvider(room, this.doc, {
      signaling: this.settings.infra.signalingUrls,
      peerOpts: this.settings.infra.iceServers
        ? { config: { iceServers: this.settings.infra.iceServers } }
        : undefined,
    })
    this.rtcProvider.awareness.setLocalStateField('user', {
      address: this.ownAddress,
      nickname: this.nickname,
    })
    this.rtcProvider.awareness.on('change', () => this.onAwarenessChange())
  }

  if (this.settings.infra.webSocketUrl) {
    this.wsProvider = new WebsocketProvider(
      this.settings.infra.webSocketUrl,
      room,
      this.doc,
      this.rtcProvider ? { awareness: this.rtcProvider.awareness } : undefined,
    )
  }

  // Keep debounce + Swarm write, but guard remote origins
  this.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (this.isRemoteOrigin(origin)) return
    // ... existing debounce + publishSnapshot logic unchanged ...
  })

  this.init()

  // Legacy path — only when no y-providers are configured
  if (!this.rtcProvider && !this.wsProvider) {
    this.startFetchProcess()
  }

  this.startMemberListPoll()
}
```

**`stop()` — add provider cleanup:**

```typescript
this.rtcProvider?.destroy()
this.rtcProvider = null
this.wsProvider?.destroy()
this.wsProvider = null
// existing cleanup unchanged below
```

**`onAwarenessChange` — new private method** (replaces JOIN sentinel):

```typescript
private onAwarenessChange(): void {
  const awareness = this.rtcProvider?.awareness ?? this.wsProvider?.awareness
  if (!awareness) return

  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue
    const userState = (state as { user?: { address?: string } }).user
    if (!userState?.address) continue
    const address = remove0x(userState.address.toLowerCase())
    if (address === this.ownAddress || this.members.has(address)) continue
    this.registerMember(address)
    this.emitter.emit(DOC_EVENTS.MEMBERS_UPDATED, this.members.all())
    // Fill gaps from periods when this peer was offline relative to us
    this.fetchLatestFromMember(address)
  }
}
```

**`publishSnapshot` — conditional notification publish:**

```typescript
// After the Swarm write, replace the unconditional notificationProvider.publish call:
if (!this.rtcProvider && !this.wsProvider) {
  this.notificationProvider?.publish({
    v: 1,
    topic: this.docTopic,
    author: this.ownAddress,
    feedIndex: Number(nextIndex),
    delta,
  })
}
```

When y-providers are active, `doc.on('update')` propagates the update automatically — no manual publish needed.

**`initMemberList` — remove JOIN sentinel publish:**

Remove the `this.notificationProvider.publish({ ..., feedIndex: JOIN_FEED_INDEX })` call entirely. The awareness field
set in `start()` replaces it.

**`registerMember` — conditional `addMember`:**

```typescript
private registerMember(address: string): void {
  if (!this.members.register(address)) return
  if (!this.rtcProvider && !this.wsProvider) {
    this.notificationProvider?.addMember?.(address)
  }
  console.log(`${TAG} registerMember: ${address.slice(0, 8)}…`)
}
```

---

### Step 4 — Update app layer

**Files:** `src/app/hooks/useSession.ts`, `src/app/TestPage.tsx`, `src/app/hooks/useSwarmDoc.tsx`

**`useSession.ts`:**

- Remove `Transport` enum entirely
- Remove `transport: Transport` from `Session` interface
- Remove `transport` parameter from `createSession` and `login`

**`TestPage.tsx`:**

- Remove imports: `Transport`, `BroadcastChannelNotificationProvider`, `SwarmFeedNotificationProvider`,
  `NotificationProvider`, `makeNotificationProvider`
- Remove transport selector buttons from `LoginView`
- Add `DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'ws://localhost:4444'`
- Add `signalingUrl` state (sessionStorage key `'signaling_url'`) to `LoginView` config fields
- Remove `notificationProvider` from `docConfig`
- Add `signalingUrls: signalingUrl ? [signalingUrl] : []` to `infra`

**`useSwarmDoc.tsx`:**

- Remove `notificationProvider` from destructure and deps array
- New dep array: `[user.privateKey, infra.topic, infra.beeUrl, infra.stamp, infra.signalingUrls?.join(',')]`

---

### Step 5 — Remove notification exports from `lib/index.ts`

**File:** `src/lib/index.ts`

Remove:

```typescript
export type { NotificationPayload, NotificationHandler, NotificationProvider }
export { BroadcastChannelNotificationProvider }
export { SwarmFeedNotificationProvider }
```

---

### Step 6 — Remove from `interfaces/index.ts`

**File:** `src/lib/interfaces/index.ts`

Remove:

```typescript
export * from './notification'
```

---

### Step 7 — Delete files

```
src/lib/notification/swarmFeed.ts
src/lib/notification/broadcastChannel.ts
src/lib/interfaces/notification.ts
```

Run `pnpm check:types` — must pass before continuing.

---

### Step 8 — Remove `notificationProvider` from `settings.ts`

**File:** `src/lib/interfaces/settings.ts`

- Remove `import { NotificationProvider } from './notification'`
- Remove `notificationProvider?: NotificationProvider` field

---

### Step 9 — Clean up constants

**File:** `src/lib/utils/constants.ts`

- Remove `NOTIFY_FEED_SUFFIX` — only used by deleted `swarmFeed.ts`
- Remove `JOIN_FEED_INDEX` — only used in `doc.ts` JOIN publish which was removed
- Remove `FEED_INDEX_ZERO` if unused (grep first to confirm)
- Remove `JOIN_FEED_INDEX` from `src/lib/index.ts` export if present

Run `pnpm check:types` — must pass.

---

### Step 10 — Vite config externals

**File:** `vite.config.mts`

```typescript
external: ['@ethersphere/bee-js', 'react', 'react-dom', 'y-webrtc', 'y-websocket'],
globals: {
  // ...existing...
  'y-webrtc': 'YWebrtc',
  'y-websocket': 'YWebsocket',
},
```

---

### Step 11 — Signaling server

**File:** `signaling-server/package.json`

```json
{
  "name": "swarm-collab-signaling",
  "description": "y-webrtc signaling server — run from repo root after installing y-webrtc",
  "scripts": {
    "start": "PORT=4444 node ../node_modules/y-webrtc/bin/server.cjs"
  }
}
```

Delete `signaling-server/index.cjs` — it used a custom protocol incompatible with y-webrtc.

---

## Files Summary

### Changed

| File                             | Change                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/interfaces/settings.ts` | Add `signalingUrls`, `webSocketUrl`, `iceServers`; `notificationProvider?` → removed                                                |
| `src/lib/doc/doc.ts`             | Add providers, `isRemoteOrigin`, `onAwarenessChange`, update `start`, `stop`, `publishSnapshot`, `initMemberList`, `registerMember` |
| `src/lib/utils/constants.ts`     | Remove `NOTIFY_FEED_SUFFIX`, `JOIN_FEED_INDEX`, optionally `FEED_INDEX_ZERO`                                                        |
| `src/lib/index.ts`               | Remove notification exports                                                                                                         |
| `src/lib/interfaces/index.ts`    | Remove notification re-export                                                                                                       |
| `src/app/hooks/useSession.ts`    | Remove `Transport` enum + field                                                                                                     |
| `src/app/TestPage.tsx`           | Remove transport selector, add signaling URL input                                                                                  |
| `src/app/hooks/useSwarmDoc.tsx`  | Remove `notificationProvider` from deps                                                                                             |
| `vite.config.mts`                | Add y-webrtc, y-websocket externals                                                                                                 |
| `signaling-server/package.json`  | Point to `y-webrtc/bin/server.cjs`                                                                                                  |

### Deleted

- `src/lib/notification/swarmFeed.ts`
- `src/lib/notification/broadcastChannel.ts`
- `src/lib/interfaces/notification.ts`
- `signaling-server/index.cjs`

### Unchanged

- `src/lib/doc/members.ts` — entirely unaffected
- `src/lib/doc/events.ts` — `DOC_EVENTS` unchanged
- `src/app/components/DocEditor/DocEditor.tsx` — receives `Y.Doc`, transport-agnostic
- All Swarm write paths in `doc.ts` — `publishSnapshot` Swarm write, `initOwnIndex`, `initMemberList`, `fetchSnapshot`,
  `applyDelta`, `startMemberListPoll`, `refreshMemberList`

---

## Open Questions / Considerations

1. **Member list P2P addresses:** `y-webrtc` uses the signaling server for peer discovery, not Swarm addresses. The
   members list retains its cold-start role. Awareness could carry a signaling URL for dynamic discovery, but that is
   out of scope.

2. **y-websocket persistence:** The gateway y-websocket server is a pure relay by default. Swarm remains the persistence
   layer. y-websocket adds value as an always-online relay peer for NAT traversal, not as a Swarm replacement.

3. **`@solarpunkltd/comment-system` in `doc.ts`:** Still used for doc feed reads/writes (`readSingleComment`,
   `writeCommentToIndex`). Separate from the notification system, unaffected by this change. Could be replaced with
   direct bee-js calls in a future cleanup.

4. **Swarm write frequency:** Every local edit still writes a full snapshot to Swarm. With y-webrtc active, online peers
   receive incremental deltas via WebRTC; Swarm is only read by new/offline joiners. No change needed.

5. **Awareness type safety:** `awareness.getStates()` returns `Map<number, Record<string, unknown>>`. The cast
   `(state as { user?: { address?: string } }).user` is necessary and intentional.

---

## Verification Checklist

1. Start signaling server: `cd signaling-server && npm start` (or `PORT=4444 node node_modules/y-webrtc/bin/server.cjs`
   from repo root)
2. Run app: `pnpm dev`
3. Open two browser tabs at `http://localhost:5002`
4. Tab A: enter username, set signaling URL to `ws://localhost:4444`, click Join
5. Tab B: same sequence
6. Edit text in Tab A → Tab B updates in real time (sub-100 ms, no polling)
7. DevTools → Network: confirm **no** repeated requests to `localhost:1633` after join
8. Close Tab A → Tab B's member list updates (`awareness` removal fires `MEMBERS_UPDATED`)
9. New Tab C joins → gets current doc state via y-webrtc Sync Step 1/2 from Tab B (not Swarm)
10. All tabs closed → fresh Tab D → reads from Swarm (cold-start path), gets last snapshot
11. `pnpm check:types` → zero errors
