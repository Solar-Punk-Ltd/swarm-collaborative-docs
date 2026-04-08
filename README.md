# Swarm Collaborative Docs

## What this project is

A proof-of-concept for Google Docs-style real-time collaborative document editing built entirely on Ethswarm — a
decentralized, censorship-resistant storage network. No central server, no WebSocket backend. Peers discover each other
and sync state via Swarm feeds and a browser BroadcastChannel.

## Tech stack

### Layer Tech

Storage / transport @ethersphere/bee-js v11 — Swarm HTTP API client CRDT yjs — conflict-free replicated data type for
collaborative text Feed primitives @solarpunkltd/comment-system v1.9.2 — wraps Swarm feed read/write Frontend React 19 +
Vite 7, TypeScript, SCSS Monorepo pnpm workspaces Notification (dev) BroadcastChannel API — same-browser tab-to-tab
signaling Architecture

## Swarm primitives used

Swarm Feeds: append-only, owner-signed sequences of chunks. Each user writes to their own feed — no shared mutable
state, no write conflicts. Postage stamps: prepaid storage tickets. Two types in use: Immutable stamp — for
permanent/archival data Mutable stamp — circular buffer behavior; new writes overwrite oldest chunks. Used for snapshots
(only the latest matters). Chunks: 4KB content-addressed storage units. Feed entries point to chunk references. Per-user
feed model Every participant writes exclusively to their own feed, keyed by:

Topic = rawTopic + "\_doc" + ownAddress // doc state feed Topic = rawTopic + "\_manifest" // room membership (consensus
key) No user ever writes to another's feed. The CRDT (Yjs) makes all writes commutative and idempotent — order of merge
doesn't matter.

## Manifest feed (member discovery)

A consensus key is derived deterministically from the room topic — anyone who knows the topic ID can derive it and write
to the manifest feed. The manifest stores a JSON array of member Ethereum addresses. On join:

User reads manifest → gets existing member list Appends own address → writes updated manifest back (last-write-wins,
conflicts acceptable) Publishes a join notification (feedIndex: -1 sentinel) so online peers discover the new member and
subscribe Duplicate-join guard: if own address is already in the manifest, skip the write.

## Sync flow

On startup (init):

Validate both postage stamps (usable, mutable stamp must have immutableFlag=false) Read manifest → register all existing
members For each member: fetch their latest doc snapshot from Swarm, apply to local Yjs doc Publish join notification to
signal presence to online peers On local edit (debounced 500ms):

Capture accumulated Yjs incremental deltas (pendingUpdates) Write full Yjs state snapshot (Y.encodeStateAsUpdate(doc))
to own Swarm feed using mutable stamp (overwrites previous snapshot — only latest matters) Send Yjs delta
(Y.mergeUpdates(pendingUpdates)) in the notification payload for online peers On receiving notification:

Self-notifications: ignored Join notification (feedIndex: -1): register new member, fetch their latest snapshot from
Swarm Doc update notification: fast path — apply delta bytes directly from payload (no Swarm read needed for online
peers); slow path — read snapshot from Swarm at the specific feedIndex with retries (handles propagation delay where
chunk isn't served yet) CRDT correctness Yjs state is stored as full snapshots (Y.encodeStateAsUpdate), not incremental
deltas. This prevents cross-session clientID accumulation that caused content duplication. Text edits use diff-based
binding (applyDiff) — detects common prefix/suffix and only inserts/deletes the changed range. Prevents full-replace
from destroying other users' Yjs item IDs. Binary encoding: base64 (Buffer.from(bytes).toString('base64')) — 33%
overhead vs 100% for hex. Topic namespace separation: \_doc suffix prevents the doc feed from colliding with any
existing comment feeds on the same topic. Notification provider BroadcastChannelNotificationProvider — uses the
browser's BroadcastChannel API for same-browser tab communication. This is the dev/POC transport. For production
cross-device sync, this would be replaced with a Swarm-native notification provider (e.g., Swarm PSS or a relay feed).

## Repository structure (swarm-collaborative-docs)

```
src/
  lib/ ← the collaborative doc library
    lib/doc.ts ← SwarmDoc class (core)
    lib/manifest.ts ← consensus manifest feed
    lib/notifications/ ← BroadcastChannelNotificationProvider, SwarmFeedNotificationProvider
    utils/ ← common, bee, eventEmitter, logger, error
    interfaces/ ← notification, settings types
    index.ts ← library entry point
  app/ ← standalone test/dev app
    TestPage.tsx ← dev harness: session identity, member list, doc UI
    hooks/useSwarmDoc.tsx ← React hook wrapping SwarmDoc lifecycle
    components/DocEditor/ ← textarea bound to Y.Text via applyDiff
    main.tsx ← React entry point
index.html ← HTML host for dev
vite.config.mts ← build config; supports lib and app modes
tsconfig.json ← project config
tsconfig.lib.json ← library-only config (npm package)
.env.example ← BEE_API_URL, STAMP, MUTABLE_STAMP, ENV
```

## To run:

```bash
cp .env.example .env # fill in stamp IDs and Bee API URL
pnpm install
pnpm start # starts app on :3002, lib compiled on-the-fly by Vite
```

## To build:

```bash
pnpm build # builds library + types to dist/
```

## Key design decisions & rationale

| Decision                        | Why                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Per-user feeds, no shared feed  | Avoids write conflicts entirely; each user owns their slot                                                                  |
| Full snapshots over deltas      | Incremental deltas + new Yjs clientID per session = content duplication                                                     |
| Mutable stamp for snapshots     | Only latest snapshot matters; mutable stamp acts as circular buffer, saves storage                                          |
| Delta in notification payload   | Eliminates Swarm read for online peers; near-instant sync                                                                   |
| feedIndex: -1 join sentinel     | Reuses existing notification infrastructure without a new message type                                                      |
| src/lib + src/app structure     | Clear separation of library (npm package) from dev app; lib isomorphic, app demo only                                       |
| BUILD_MODE=lib env var          | Vite config adapts build behavior based on mode; lib build uses dts plugin for types                                        |
| tsconfig.lib.json for lib types | Isolated type check/emit for library code; prevents app-specific (e.g., SCSS, React hooks) from polluting npm package types |

Current limitations BroadcastChannel only works within the same browser — cross-device sync requires a real Swarm
notification transport (PSS, relay feed, or similar) No offline-join support — if peer A is offline when peer B joins, A
won't receive the join notification; B must re-join or A must poll the manifest on reconnect Manifest is public and
writable by anyone with the room ID — suitable for trusted/invited groups; not spam-resistant for fully public rooms No
persistence of manifest membership across reconnects — if a peer goes offline and comes back, they re-announce
themselves but won't re-discover peers who joined while they were offline unless those peers are also online Propagation
delay — Swarm chunk propagation isn't instant; the retry logic (3× with 250ms delay) may need tuning for slower nodes or
high-load networks Single textarea editor — no rich text, no cursor presence, no awareness of who is typing where

## Planned / future scope

ACT (Swarm Access Control Theory) — encrypt the manifest and doc feeds so only invited grantees (added by Ethereum
pubkey, like email access in Google Docs) can read. The file-manager-lib pattern: public feed stores encrypted topic
ref, grantees can decrypt. This makes the collaboration fully private and access-controlled on-chain. Modularize lib —
currently packages/lib is a monolith; split into doc, manifest, notifications sub-modules Production notification
provider — replace BroadcastChannel with Swarm PSS (Postal Service over Swarm) or a relay feed for cross-device
real-time sync Cursor / presence awareness — Yjs Awareness protocol for showing other users' cursor positions Conflict
resolution UI — currently silent CRDT merge; surface merge events to users Stamp management UI — currently stamps are
configured via .env; future: UI to purchase/select stamps

## License

[Apache-2.0](./LICENSE)
