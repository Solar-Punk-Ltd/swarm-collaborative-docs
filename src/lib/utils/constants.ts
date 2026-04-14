import { FeedIndex } from '@ethersphere/bee-js'

// Placeholder stamp used when a smart gateway handles postage (no local stamp needed)
export const PLACEHOLDER_STAMP = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n)

// Feed namespace suffixes — appended to the room topic before hashing to isolate feed families
export const DOC_FEED_SUFFIX = '_doc'
export const MEMBERS_FEED_SUFFIX = '_members'
export const NOTIFY_FEED_SUFFIX = '_notify'
export const SIGNAL_FEED_SUFFIX = '_signal'
// feedIndex sentinel: peer join notification — no doc content, just "I'm here"
export const JOIN_FEED_INDEX = -1 // TODO: why not bigint ?
export const DEFAULT_ICE_SERVER_URL = 'stun:stun.l.google.com:19302'
export const DEFAULT_SIGNALING_SERVER_URL = 'ws://localhost:4444'
export const DEFAULT_BEE_API_URL = 'http://localhost:1633'
export const DEFAULT_TOPIC = 'test-topic-1'
