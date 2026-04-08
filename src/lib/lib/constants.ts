import { FeedIndex } from '@ethersphere/bee-js'

export const EVENTS = {
  LOADING_INIT: 'loadingInit',
  LOADING_PREVIOUS_MESSAGES: 'loadingPreviousMessages',
  MESSAGE_RECEIVED: 'messageReceived',
  MESSAGE_REQUEST_INITIATED: 'messageRequestInitiated',
  MESSAGE_REQUEST_UPLOADED: 'messageRequestUploaded',
  MESSAGE_REQUEST_ERROR: 'messageRequestError',
  CRITICAL_ERROR: 'criticalError',
}

export const DOC_EVENTS = {
  DOC_UPDATED: 'docUpdated',
  DOC_ERROR: 'docError',
  MANIFEST_UPDATED: 'manifestUpdated', // payload: string[] of member addresses
}

// placeholder stamp if smart gateway is used
export const PLACEHOLDER_STAMP = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n)
