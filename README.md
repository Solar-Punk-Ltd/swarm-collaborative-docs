# swarm-collaborative-docs

Serverless, real-time collaborative editing over [Swarm](https://ethswarm.org).

Peers share one [Yjs](https://docs.yjs.dev) document. Every session writes its own full CRDT snapshot to a Swarm feed
nobody else owns, and broadcasts incremental deltas over WebRTC to whoever is online. Swarm is the durable layer and the
discovery layer; WebRTC is the fast one. Nothing sits in the middle of either — no database, no coordinator, and with
the default transport no signaling server.

This document explains how the pieces fit and where each one lives. It is not an API reference: signatures and options
are documented at their declarations under [`src/lib/interfaces`](src/lib/interfaces).

---

## The model

A session is made of three things: a **room**, the **people** in it, and their **open tabs**.

**Room.** A room is a secret and nothing else. Creating one mints a random key, and every Swarm address the room uses is
computed from that key by hashing it. There is no room record to look up and no room name to guess: hold the key and you
can work out where the room's feeds live; without it they are unremarkable 32-byte addresses among all the others. The
key itself is never written to Swarm and never sent to a server — it travels in the fragment of an invite link, which
browsers keep to themselves. [`src/lib/utils/room.ts`](src/lib/utils/room.ts)

**Member identity.** One person, addressed by their secp256k1 address. Everything they contribute is attributed to it,
and each member owns exactly one _announce_ feed, where they publish which of their tabs are currently open. The code
calls this an **identity** — it means any participant, not the room's organiser. (The creator appears in one place only:
as a starting point for discovery, described below.)

**Session.** One open tab. Each tab signs with its own key, derived from the member's private key plus a `sessionId`, so
two tabs belonging to the same person are two independent writers rather than two writers fighting over one feed.

Four feeds, all append-only, all read by explicit index:

| Feed          | One per | Written by         | Carries                                             |
| ------------- | ------- | ------------------ | --------------------------------------------------- |
| **Directory** | room    | anyone in the room | the identities known to be in the room              |
| **Announce**  | member  | that member        | their open sessions, plus identities they have seen |
| **Snapshot**  | session | that session       | the full document state, rewritten at every index   |
| **Signal**    | session | that session       | the current SDP offer and answer (SwarmRtc only)    |

Why four rather than one shared list? A member's announce feed is addressed _from_ their identity, so you cannot read
the feed of someone you have never heard of — there is no address to ask for. The directory solves exactly that and
nothing else: an append-only list of identities, never rewritten, so two members writing at the same moment cost one
index and a retry instead of one erasing the other. Everything below it has a single writer, which is what makes losing
another member's entry impossible rather than merely unlikely. The shared roster feed (or graffiti feed) this replaces
lost entries in precisely that way — every writer republished the whole list from its own copy.

### Who can write what

Two different kinds of key sign those feeds, and the difference between them is the whole security story.

- **Room-derived keys** sign the directory and every announce feed. They are computed from the room secret alone, so
  everyone in the room can write them. That is what makes a shared directory work without a coordinator, and it also
  means any member can forge an entry there — claim a session that is not theirs, or list someone who never joined.
  Membership is trust-on-first-use.
- **Identity-derived keys** sign the snapshot and signal feeds. A session's signing key comes from the member's own
  private key plus its `sessionId`, and the room secret cannot produce it. Swarm feeds are single-owner: a node accepts
  an update only if the feed's owner signed it. So nobody — not another member, not the gateway — can write into your
  snapshot feed or alter what you already put there. Deltas sent over WebRTC carry a signature checked against the
  sender's session address, so the same holds on the fast path.

What this does _not_ give you is a closed room. Anyone holding the key is a participant by definition: they can read
everything and publish a document feed of their own, which everyone else will merge. The guarantee is narrower and still
worth having — **nobody can put words in your mouth, and nobody can change or delete what you wrote.** Whether the room
is trustworthy is decided by who you hand the link to.

![Architecture overview](./docs/architecture-overview.svg)

---

## Invitations

A room is created by minting a key and handing out a link. There is no registration step and nothing to look up.

```typescript
import { createRoomKey, encodeRoomInvite } from '@solarpunkltd/swarm-collaborative-docs'

const link = `${appUrl}#${encodeRoomInvite({ key: createRoomKey(), creator: myIdentityAddress })}`
```

The joiner's side is `decodeRoomInvite(window.location.hash)`. The demo app does this in
[`src/app/utils/url.ts`](src/app/utils/url.ts): it consumes the invite on load and on `hashchange`, persists it, then
strips the fragment from the address bar.

The link carries a version, the key, the creator's identity, and optionally a transport and document kind. `creator` is
not authority — it is a head start, one announce feed that can be read before the directory answers.

**What this buys**

- A room name is no longer a credential. Feeds are keyed by a random secret, so guessing or overhearing a document id
  grants nothing.
- Nothing in a link goes stale. Every address derives from the key, so an invite minted once keeps working as the room
  grows.
- The secret sits in the fragment, which browsers never send to a server: it stays out of gateway access logs and out of
  `Referer` on every outbound link. A query parameter would leak it on both.

**What it costs**

- It is a bearer secret. There is no per-person access and no revocation — forwarding the link hands over the room, and
  rotating means a new room plus copying the document into it.
- It lives in a URL, so it reaches browser history, clipboards and chat logs. Stripping the fragment after reading it
  does not undo any of that.
- The key is the whole membership check, so the room list is only as accurate as the people you gave it to — see
  [Who can write what](#who-can-write-what).
- Content is stored in plaintext under the postage stamp. Anyone who holds the key and can reach a Bee node can read the
  document.

---

## Identity, and what is visible

The library does not choose your identity — it takes a private key and derives everything else from it. The demo app
generates a random one per browser and keeps it in `localStorage`, which makes each participant a pseudonym that exists
only inside that app. An application is free to supply a key that stands for something real instead: a Swarm ID, or a
key held by a wallet. That substitution is the single biggest privacy decision here, and it is made outside this
library.

What it changes: an identity address is written in the clear into announce entries and onto every notification payload.
Anyone with the room key therefore sees who is in the room, under whatever that key represents. A random per-app key
links your own tabs to each other and nothing else. A wallet address links this room to everything else that address has
ever done, for as long as the stamps keep the chunks alive.

| Who                             | Sees                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Anyone holding the room key     | everything: the member list, every identity address, the full document and its history                  |
| The Bee node or gateway you use | the same, plus your IP address — it stores the chunks, serves the reads, and every payload is plaintext |
| Swarm nodes storing your chunks | the raw bytes. A chunk lands in whichever neighbourhood its address falls in, in the clear              |
| Anyone else                     | nothing they can locate — feed addresses are hashes of the room secret, so there is nothing to ask for  |

So today a gateway is a trusted party. Running your own Bee node removes that trust; encrypting content before it is
uploaded removes the need for it, which is what [Future improvements](#encrypted-content-and-per-person-access)
describes.

---

## Data flows

### Joining a room

1. `Room` derives the namespace and every feed key from the secret.
2. `Members.add()` reads the directory, appends this identity to it if it is missing, then writes the session into this
   identity's announce feed. Listed before announced, because a member already in the room learns that a new identity
   exists only by polling the directory.
3. `Members.read()` drains the directory, then reads the announce feed of every identity it names. Announce payloads
   repeat their writer's own `known` list, which gives a second path to the same identities when a directory index is
   momentarily unreadable.
4. Every session found is registered and handed to the transport to dial; its snapshot feed is read immediately.
5. A `join` notification goes out on the transport, so peers already connected fetch now instead of at their next poll.
6. The member list is re-read every 5 s, and on demand via `refreshMemberList()`.

[`src/lib/doc/members.ts`](src/lib/doc/members.ts), [`SwarmDoc.initMemberList`](src/lib/doc/doc.ts)

### Connecting a peer — SwarmRtc

Roles are deterministic: the lower session address initiates, so two peers never offer each other at once.

1. The initiator creates the connection, gathers ICE to completion, and writes **one** offer record into its own signal
   feed, addressed to the peer.
2. It then leaves the peer's feed alone for a few seconds. An answer cannot exist yet, and asking for a chunk that does
   not exist is what makes it unreadable once it does — see
   [Reading feeds](#reading-feeds-the-constraint-behind-the-timings).
3. The answerer, polling every 2 s, finds the offer addressed to it, answers into its own signal feed, and arms its own
   watchdog.
4. The initiator reads the answer, applies it, and DTLS completes. The data channel opens.
5. Both sides send a Yjs **state vector** and reply with only the updates the other lacks — smaller than pushing a whole
   document, and self-healing if one direction is lost.

Failure handling, all in [`swarmRtcTransport.ts`](src/lib/notification/swarmRtcTransport.ts):

- A connection that has not become usable within 90 s is torn down and renegotiated. ICE reaching `connected` does not
  mean the channel works — DTLS can stall in `connecting` forever without ever firing `failed`.
- Retries are scheduled 5 s apart and capped at 5 consecutive failures, so a tab that closed is not dialled for the rest
  of the session. Its snapshot feed still holds everything it wrote.
- Any fresh signal record from a peer clears its retry count: a peer that is still negotiating earns its retries back.
- SDP older than the window its author holds the connection open for is ignored, rather than answering a peer that has
  already given up and re-offered under a new session id.
- A peer is dialled regardless of its `live` flag. That flag is shared, last-write-wins state, and a stale retire would
  otherwise strand a peer permanently; the retry cap is what stops dead sessions being dialled forever.

### Editing and persistence

A local edit is debounced 500 ms, then published once: the **full** `Y.Doc` state goes to this session's snapshot feed,
and the merged delta is broadcast to connected peers with a signature over its bytes.

Receivers verify the signature against the author's session address and apply the delta only if its feed index follows
the last one applied. A gap means the updates in between were never seen — Yjs would park the delta as pending forever,
so the peer's full snapshot is fetched instead.

`flush()` bypasses the debounce and resolves once the write is on Swarm. `WRITE_PENDING` / `WRITE_DONE` bracket that
window, which is what a "saving…" indicator and a `beforeunload` prompt hang off.

### Catching up, and the read-only gate

Two events, two different questions:

- `DOC_READY` — init finished. The document exists and is addressable.
- `DOC_SYNC_STATE` — whether the peers found at startup have actually delivered their state.

Editing a document that is still assembling means typing into a fragment and merging the result into a version the
author never saw, which is how content disappears quietly. So the editor is gated on both. `synced` latches after every
startup peer has delivered, or after a 30 s grace period, and never goes back to false — a peer arriving later must not
disable an editor somebody is typing in. `pending` keeps counting, so the UI can say so without blocking.

Two paths keep a peer's state arriving when the channel does not:

- every 15 s, the snapshot feed of every peer without an open channel is re-read;
- a channel opening triggers an immediate re-read, because everything written before it opened is missing by definition.

### Presence and cursors

Cursor positions are broadcast on a 500 ms timer as their own payload, never on the document path, and surface as
`AWARENESS_UPDATED`. `CursorPosition.scope` names the `Y.Text` the offsets belong to, so in a multi-file document a
remote caret is not drawn at the same offsets in whatever file the receiver has open.

A clean shutdown publishes `leave` and retires the session in the announce feed. A caret is only meaningful while its
owner is present and reachable, so the app filters on both before drawing — see `liveAwareness` in
[`SessionView.tsx`](src/app/components/SessionView/SessionView.tsx).

![Transport data flows](./docs/transport-flows.svg)

---

## Reading feeds: the constraint behind the timings

Most of the odd-looking numbers above come from one property of Bee, and it is worth understanding before changing any
of them.

A chunk that was never written answers 404 — but only while retrieval still has peers to ask. Every miss puts one more
peer on a per-chunk skip list for about a minute, and once they are all on it the same absent chunk answers **500**.
Polling an index a peer has not written yet therefore burns that address for a minute, _including_ for the moment the
peer finally writes it. Asking impatiently is what makes the answer unreadable.

What follows from it, all enforced in [`src/lib/utils/feed.ts`](src/lib/utils/feed.ts):

- **A failed read means _unknown_** — never present, never absent. The only positive evidence that an index is stuck is
  a later index that reads. Treating it as present walks a tail resolution off the end of a feed; stepping over it
  silently discards a handshake a peer is about to write.
- **Absent and failed are spaced apart.** A 404 is simply "not written yet" and backs off in seconds; a 500 means the
  node has given up on that address and backs off in tens of seconds.
- **Reads are by explicit index.** Asking Bee for a feed's _latest_ update runs a search whose probes time out after one
  second and count a timeout as a miss, so on a loaded node it reports a head below the real one — long enough to hide a
  peer that just joined. The unindexed lookup is used only to seed a tail resolution, which is then confirmed forward.
- **An index is claimed before the upload and stays claimed if it throws.** A failed write may still have stored its
  chunk, and two payloads at one address leave a chunk the node can no longer serve at all.
- **Feed writes are deferred.** A direct upload never lands in the local chunk store, so the writer's own read-back
  misses locally and falls through to network retrieval — straight into the skip list described above.

---

## Events

Subscribe with `swarmDoc.getEmitter().on(DOC_EVENTS.X, handler)`. Declarations and payloads:
[`src/lib/doc/events.ts`](src/lib/doc/events.ts).

| Event                | Payload                                   | Meaning                                                        |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `DOC_READY`          | `{ memberCount }`                         | Init finished — the document exists, peers may still owe state |
| `DOC_SYNC_STATE`     | `{ synced, pending }`                     | Startup peers have delivered (latching), and how many have not |
| `DOC_UPDATED`        | `Y.Doc`                                   | A remote update was applied                                    |
| `DOC_ERROR`          | `Error`                                   | Stamp validation, feed position or publish failure             |
| `TRANSPORT_READY`    | `true`                                    | The transport's own channel is usable; says nothing of peers   |
| `MEMBERS_UPDATED`    | `Map<string, MemberEntry>`                | Peer list changed, keyed by session address                    |
| `PEERS_CONNECTED`    | `true`                                    | At least one **remote** peer connected; never for a lone peer  |
| `PEER_STATE_UPDATED` | `Map<string, PeerConnectionState>`        | Per-session connection state changed                           |
| `AWARENESS_UPDATED`  | `{ address, identity, username, cursor }` | A peer's caret moved, or cleared with `cursor: null`           |
| `WRITE_PENDING`      | `true`                                    | Local edits queued, not yet on Swarm                           |
| `WRITE_DONE`         | `true`                                    | Every queued local edit has been written                       |

Gate an editor on `DOC_READY` **and** `DOC_SYNC_STATE.synced`. Gate a presence indicator on `PEERS_CONNECTED` — it never
fires for the first person in a room, which is the normal state of whoever created it.

`MemberEntry` carries `identity` alongside the session address, so a UI can group one person's tabs into a single row
with a dot per session; `live: false` marks a session that shut down, whose snapshots are still read.

---

## Extending it

**A transport** implements [`DocTransport`](src/lib/interfaces/doc.ts) and is passed as a factory, receiving
`DocTransportDeps` — the `Y.Doc`, the member set, the emitter, this session's signer and addresses, and
`onPeerDiscovered`. What a transport owes: route `NotificationPayload`s both ways, emit `PEER_STATE_UPDATED` as
connections come and go, report peers it learns about itself through `onPeerDiscovered`, and answer `isRemoteOrigin` so
updates it applied are not echoed back out. Persistence, discovery over Swarm, cursors and the sync gate all sit above
the transport and come for free — the two shipped ones share no state and know nothing about each other.

**Discovery** is not pluggable today — `SwarmDoc` constructs `Members` itself. The extension point that exists is
`onPeerDiscovered`: a transport that already knows its peers (an awareness protocol, a registry, an ENS list) can push
them in, and the Swarm feeds then act as the durable fallback. `infra.members` is display hints only; an identity
address alone cannot address a session's feeds.

**Editors** bind to `swarmDoc.doc` directly — any Yjs binding works, and the library never calls `getText` itself.
Multi-file is one named `Y.Text` per path (`doc.getText('contracts/Token.sol')`) inside the one document, with
`CursorPosition.scope` set to the same key. The demo wires Monaco via `y-monaco` and draws remote carets from
`AWARENESS_UPDATED` rather than `y-monaco`'s awareness path, since the library surfaces cursors as events rather than a
`Y.Awareness` instance: [`MonacoEditor.tsx`](src/app/components/MonacoEditor/MonacoEditor.tsx),
[`workers.ts`](src/app/components/MonacoEditor/workers.ts) for the Vite worker setup.

**Unshipped transports** live in [`src/experimental/`](src/experimental) — Swarm GSOC pubsub and Waku. They are not
exported, not built, not supported, and deliberately absent from the diagrams above. They are written against the same
`DocTransport` interface, so they are a reasonable starting point for one of your own. See also
[Waku-and-Swarm-pubsub](./docs/transport-flows-pubsub-waku.svg)

---

## Transports

Both shipped transports share the same persistence and discovery layer, so a peer that was offline converges either way.
There is no default and no built-in server address: each factory throws at construction if a required option is missing
or carries the wrong URL scheme.

### `createSwarmRtcTransport` ✓ recommended

SDP is exchanged through each session's signal feed, so there is no server to operate beyond a Bee node. Binary frames
on the data channel are Yjs updates, string frames are JSON payloads. Takes `iceServers` — STUN is enough when one side
is directly reachable; symmetric NAT needs TURN with credentials.

### `createSignalingServerTransport`

Uses [y-webrtc](https://github.com/yjs/y-webrtc) against a WebSocket signaling server **you run**; the server relays SDP
and ICE only, never document data. y-webrtc owns Yjs sync and cross-tab BroadcastChannel; cursors are bridged through
`Y.Awareness`. Takes `signalingUrl` and `iceServers`. `y-webrtc` is an optional peer dependency, resolved by dynamic
`import()` on `start()`, so a missing package surfaces as `DOC_ERROR` rather than breaking a build.

|                          | SwarmRtc ✓ | Signaling server |
| ------------------------ | :--------: | :--------------: |
| No server to operate     |     ✓      |        ✗         |
| Requires a Bee node      |     ✓      |   for storage    |
| Requires STUN/TURN       |     ✓      |        ✓         |
| Extra npm package        |     ✗      |    `y-webrtc`    |
| Connection setup latency |  seconds   |    sub-second    |

![SwarmRtc transport](./docs/transport-swarmRtc.svg)

![Signaling server transport](./docs/transport-yWebrtc.svg)

---

## Using it

```bash
pnpm add @solarpunkltd/swarm-collaborative-docs yjs
pnpm add y-webrtc # only with createSignalingServerTransport
```

`yjs` is a required peer dependency and deliberately not bundled: every editor binding imports Yjs itself, and two Yjs
instances in one page do not recognise each other's types or relative positions. `@ethersphere/bee-js` stays external
for the same reason. The package is ESM-first and ships `.mjs`, `.cjs` and declarations; supported toolchains are
bundlers (`moduleResolution: "bundler"`) and Node ≥ 22.12.

```typescript
const swarmDoc = new SwarmDoc({
  user: {
    privateKey, // secp256k1, hex
    nickname: 'Alice',
    sessionId: getOrCreateSessionId(), // one per tab, persisted in sessionStorage
  },
  infra: {
    beeUrl: 'http://localhost:1633',
    stamp: postageBatchId,
    roomKey: invite.key,
    roomCreator: invite.creator,
    transport: createSwarmRtcTransport({ iceServers: [{ urls: 'stun:…' }] }),
  },
})

swarmDoc.start()
const text = swarmDoc.doc.getText('content')
window.addEventListener('beforeunload', () => swarmDoc.flush())
```

Every field is documented at its declaration in [`interfaces/settings.ts`](src/lib/interfaces/settings.ts). React apps
can take [`useSwarmDoc`](src/app/hooks/useSwarmDoc.tsx) as-is: it is a thin mapping of every event onto component state.

**Sessions.** `sessionId` must be unique per tab and stable across reloads — `sessionStorage` is exactly that. Two tabs
sharing one id write the same feeds with independent index counters and silently overwrite each other.

**Postage.** Every participant writes their own feeds, so every participant needs a usable batch on the node their
`beeUrl` names. There is no read-only participant mode. The batch is validated during `start()`; an unusable one raises
`DOC_ERROR` rather than failing at the first write. How batches are bought and distributed — per user, app-provisioned,
sponsored — is the application's decision and its trust model.

**Tunables**, fixed in this version: 500 ms edit debounce, 5 s member poll, 15 s snapshot poll for peers without a
channel, 30 s sync grace; and in SwarmRtc a 2 s signal poll, 5 s retry spacing capped at 5, and a 90 s connect timeout.
The connection mesh is full: _N_ peers means _N−1_ channels and _N−1_ signal feeds polled against one Bee node — see
[Limitations](#limitations) for what that costs.

### Behind a gateway

Apps that do not ask users to run a Bee node point `beeUrl` at a public one. The gateway performs reads and writes; the
user's key never leaves the browser, and feed updates are signed locally before submission. Both transports work this
way; if the app already runs a WebSocket server, hosting a y-webrtc signaling endpoint on it buys a faster handshake.

A page served over `https://` cannot talk to an `http://` Bee node: browsers block it as mixed content before any CORS
header is read, so a permissive `Access-Control-Allow-Origin` changes nothing. Loopback (`http://localhost:1633`) is the
exception, which is why a local node works from an HTTPS page and a remote one does not. Terminate TLS in front of the
node and let that proxy set CORS.

---

## Example app

A minimal application in [`src/app`](src/app) demonstrating both transports, Monaco and a plain-textarea editor, the
invite flow, the member panel and remote cursors.

```bash
pnpm install
pnpm start
```

Runs at `http://localhost:5002`. The login screen mints or accepts a room key, picks a transport and document kind, and
takes the Bee URL, postage batch and STUN/TURN URL; the last two are required. Both screens can copy the invite link —
that link is what grants access, not the room id shown beside it.

---

## Limitations

- **Plaintext.** Snapshots, deltas and the member list are stored and transmitted unencrypted; the Bee node serving you
  can read all of it.
- **Bearer access.** The room key is the only credential — no per-person access, no revocation, and no verified link
  between a session and the identity it claims.
- **Forgeable membership.** Any key holder can write the directory and any announce feed. Document content is
  unaffected: snapshot feeds and deltas are signed by identity-derived keys.
- **Room size.** A member-list pass reads the announce feeds of the first 32 identities it knows, in a stable order, so
  a room that grows past that leaves the later ones permanently unread
  ([`MAX_CRAWL_IDENTITIES`](src/lib/doc/members.ts)). The mesh is full on top of that — every session dials and polls
  every other one. Both say the same thing: this is built for small groups, and neither has been tuned beyond them.
- **Multi-tab announce races.** Two tabs of one identity share an announce feed; a collision costs one index and a
  retry, and the loser adopts what the winner wrote. A per-browser writer election would remove it.

---

## Future improvements

### Encrypted content and per-person access

Two layers, and they compose. The room key is already a client-side secret nothing else knows about, so both build on
machinery that exists.

**Encrypt what is written.** Snapshot payloads and deltas go out in plaintext today. Deriving a content key from the
room secret and encrypting before upload would make everything on Swarm opaque to the node holding it, turning a gateway
from a trusted party into a dumb pipe. Swarm's own encrypted uploads reach the same place from the other end: Bee
encrypts and returns a 64-byte reference that carries the key inside it — which then has to be handled as the capability
it is, because whoever holds that reference can read those bytes forever.

**Put the key behind ACT instead of in the link.** Swarm's Access Control Trie gates a small blob to a named list of
grantees. The useful shape is to move the room key into such a blob and share the blob's handle: to anyone outside the
list that handle dereferences to nothing, so it can travel over email, chat or a public page without being the
credential. Membership then becomes a list you patch — adding a person is one small write no matter how large the
document is, and removing them cuts off everything published afterwards. With the blob addressed from the invitee's own
login instead, there is no handle to send at all: a new member finds the room by logging in.

Two limits worth stating in the same breath. Revocation only governs what comes next: whoever already read the room key
still has it, and every chunk already published stays readable to anyone holding its address, because Swarm has no
delete. Genuinely excluding someone means re-keying — a new room, and the document copied into it. And ACT names
grantees by public key, so a grant is a statement about an identity, which is only as private as the identity choice
above.

**Separate the login from the on-wire identity.** The address that signs feeds does not have to be the address you log
in with. A login can instead unseal a root secret that the signing keys derive from, so a wallet proves who you are
without that wallet address appearing in every feed you touch — and the same identity can later be unsealed by a second
credential.

### Wallet-based identity, and proof of it

Accepting any [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) provider instead of a raw private key would keep key
material out of the application. Feed writes already use a derived per-session key, so the identity key is not needed
for high-frequency signing; what is missing is proof of the link between the two. A session _claims_ its identity in the
member list and nothing checks that claim. Having the identity key sign the session address once, and carrying that
signature in the member entry, is what would make the grouping trustworthy — and is the natural shape for a
wallet-issued delegation.

### Persistent presence

Online status, active document and last-seen currently live only in the ephemeral transport layer. Persisting them to a
per-user feed would support asynchronous collaboration — who edited last, and when — without everyone being online at
once.

---

## License

[Apache-2.0](./LICENSE)
