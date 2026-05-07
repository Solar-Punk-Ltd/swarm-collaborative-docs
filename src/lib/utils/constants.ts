import { FeedIndex } from '@ethersphere/bee-js'

/** Current protocol version string included in every `NotificationPayload`. */
export const API_VERSION = 'v1'
/** Placeholder postage batch ID used in test/dev environments where stamps are not required. */
export const PLACEHOLDER_STAMP = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
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
