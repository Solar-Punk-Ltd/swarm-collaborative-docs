// v2: every feed a person writes is owned by their identity, and the member list is a run of GSOC entries.
export const API_VERSION = 'v2'
/** Snapshot feed topic: `<namespace>_doc:<sessionId>`, owned by the session's identity. */
export const DOC_FEED_SUFFIX = '_doc'
/** Announce feed topic: `<namespace>_members`, one feed per identity. */
export const MEMBERS_FEED_SUFFIX = '_members'
/** Signal feed topic: `<namespace>_doc_signal:<sessionId>`, owned by the session's identity. */
export const SIGNAL_FEED_SUFFIX = '_signal'
// Must stay true. A direct upload skips the local store (Bee `DirectUpload`), so reading it back goes to the
// network, and a failed retrieval makes the chunk unreadable for a minute (`errSkip`).
export const DEFERRED_FEED_UPLOAD = true
