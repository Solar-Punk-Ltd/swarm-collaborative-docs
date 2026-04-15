import { PLACEHOLDER_STAMP } from 'lib'

import {
  BEE_URL_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_SIGNALING_SERVER_URL,
  DEFAULT_TOPIC,
  DISABLE_UNTIL_CONNECTED_KEY,
  MUTABLE_STAMP_KEY,
  SIGNALING_URL_KEY,
  STAMP_KEY,
  STUN_URL_KEY,
  TOPIC_KEY,
  WAKU_ADDRESS_KEY,
} from './constants'

export function loadBeeUrl(): string {
  return localStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_API_URL
}

export function loadStamp(): string {
  return localStorage.getItem(STAMP_KEY) ?? PLACEHOLDER_STAMP
}

export function loadTopic(): string {
  return localStorage.getItem(TOPIC_KEY) ?? DEFAULT_TOPIC
}

export function loadMutableStamp(): string {
  return localStorage.getItem(MUTABLE_STAMP_KEY) ?? PLACEHOLDER_STAMP
}

export function loadSignalingUrl(): string {
  return localStorage.getItem(SIGNALING_URL_KEY) ?? DEFAULT_SIGNALING_SERVER_URL
}

export function loadStunUrl(): string {
  return localStorage.getItem(STUN_URL_KEY) ?? DEFAULT_ICE_SERVER_URL
}

export function loadWakuAddress(): string {
  return localStorage.getItem(WAKU_ADDRESS_KEY) || ''
}

export function loadDisableUntilConnected(): boolean {
  return localStorage.getItem(DISABLE_UNTIL_CONNECTED_KEY) === 'true'
}
