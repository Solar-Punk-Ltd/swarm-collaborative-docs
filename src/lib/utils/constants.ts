import { FeedIndex } from '@ethersphere/bee-js'

export const API_VERSION = 'v1'
export const PLACEHOLDER_STAMP = 'ca7437e1aeb4af9f306ab21f504583361695f62b25f5e2d16a118d4c601008aa'
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n)
/** Feed ID suffix for per-user document snapshot feeds: `<topic>_doc<address>`. */
export const DOC_FEED_SUFFIX = '_doc'
/** Feed ID suffix for the shared consensus member-list feed: `<topic>_members`. */
export const MEMBERS_FEED_SUFFIX = '_members'
/** Feed ID suffix for per-user notification feeds: `<topic>_notify<address>`. */
export const NOTIFY_FEED_SUFFIX = '_notify'
/** Feed ID suffix for per-user WebRTC signaling feeds: `<topic>_signal`. */
export const SIGNAL_FEED_SUFFIX = '_signal'
/** Fallback STUN server URL used alongside the primary STUN URL in `SwarmRtcTransport`. */
export const FALLBACK_ICE_SERVER_URL = 'stun:stun.cloudflare.com:3478'
