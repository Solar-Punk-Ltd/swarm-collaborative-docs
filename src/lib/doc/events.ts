// feedIndex sentinel: peer join notification — no doc content, just "I'm here"
export const JOIN_FEED_INDEX = -1

export const DOC_EVENTS = {
  DOC_UPDATED: 'docUpdated',
  DOC_ERROR: 'docError',
  MEMBERS_UPDATED: 'membersUpdated', // payload: string[] of member addresses
}
