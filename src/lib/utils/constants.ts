import { FeedIndex } from '@ethersphere/bee-js'

// Placeholder stamp used when a smart gateway handles postage (no local stamp needed)
export const PLACEHOLDER_STAMP = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n)

// Feed namespace suffixes — appended to the room topic before hashing to isolate feed families
export const DOC_FEED_SUFFIX = '_doc'
export const MEMBERS_FEED_SUFFIX = '_members'
export const NOTIFY_FEED_SUFFIX = '_notify'
