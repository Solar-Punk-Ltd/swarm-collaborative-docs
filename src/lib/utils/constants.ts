import { FeedIndex } from '@ethersphere/bee-js'

// TODO: export API_VERSION for clients if they need it
export const API_VERSION = 'v1'
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n)
/** Feed ID suffix for per-user document snapshot feeds: `<topic>_doc<address>`. */
export const DOC_FEED_SUFFIX = '_doc'
/**
 * Feed ID suffix for the announce feeds that carry member discovery: `<namespace>_members`.
 * One topic for the whole room; the owner address differs per identity, so every announce
 * feed has exactly one writer.
 */
export const MEMBERS_FEED_SUFFIX = '_members'
/** Feed ID suffix for per-user notification feeds: `<topic>_notify<address>`. */
export const NOTIFY_FEED_SUFFIX = '_notify'
/** Feed ID suffix for per-user WebRTC signaling feeds: `<topic>_signal`. */
export const SIGNAL_FEED_SUFFIX = '_signal'
/**
 * Whether feed writes are deferred, meaning stored locally first and pushed to the network in the
 * background. Every feed here is written and then read back — by the writer to confirm an index, by
 * a peer on the same node to see the update — so this must stay `true`.
 *
 * A direct (non-deferred) upload never reaches the local chunk store: Bee hands the chunk straight
 * to the pusher (`pkg/storer/netstore.go`, `DirectUpload`), so reading it back misses locally and
 * falls through to network retrieval. When that retrieval fails, Bee remembers the failure per
 * chunk and per peer for a minute (`pkg/retrieval/retrieval.go`, `errSkip`), and once every
 * candidate peer is on that list the read fails instantly for the rest of the minute — an entry the
 * writer itself just wrote reads back as an error, and the feed appears to end there.
 */
export const DEFERRED_FEED_UPLOAD = true
