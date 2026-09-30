export const API_VERSION = 'v1'
/** Snapshot feed topic: `<namespace>_doc<session address>`. */
export const DOC_FEED_SUFFIX = '_doc'
/** Topic of the directory and every announce feed: `<namespace>_members`; the owners differ. */
export const MEMBERS_FEED_SUFFIX = '_members'
/** Signal feed topic: `<namespace>_doc_signal`, one feed per session address. */
export const SIGNAL_FEED_SUFFIX = '_signal'
// Must stay true. A direct upload skips the local store (Bee `DirectUpload`), so reading it back goes to the
// network, and a failed retrieval makes the chunk unreadable for a minute (`errSkip`).
export const DEFERRED_FEED_UPLOAD = true
