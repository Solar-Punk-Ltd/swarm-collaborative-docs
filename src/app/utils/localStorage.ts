import { PLACEHOLDER_STAMP, uuidV4 } from 'lib'

import {
  BEE_URL_KEY,
  BROKER_PEER_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_BROKER_PEER,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_SIGNALING_SERVER_URL,
  DISABLE_UNTIL_CONNECTED_KEY,
  MUTABLE_STAMP_KEY,
  SESSION_KEY,
  SIGNALING_URL_KEY,
  STUN_URL_KEY,
  TOPIC_KEY,
  TRANSPORT_KEY,
  USERNAME_KEY,
  WAKU_ADDRESS_KEY,
} from './constants'
import { Session, Transport } from './types'

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)

    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function loadBeeUrl(): string {
  return localStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_API_URL
}

export function loadUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? ''
}

export function loadTopic(): string {
  return localStorage.getItem(TOPIC_KEY) ?? uuidV4()
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

export function loadTransport(): Transport {
  return (localStorage.getItem(TRANSPORT_KEY) as Transport) ?? Transport.SWARM_PUBSUB
}

export function loadWakuAddress(): string {
  return localStorage.getItem(WAKU_ADDRESS_KEY) || ''
}

export function loadBrokerPeer(): string {
  return localStorage.getItem(BROKER_PEER_KEY) || DEFAULT_BROKER_PEER
}

export function loadDisableUntilConnected(): boolean {
  return localStorage.getItem(DISABLE_UNTIL_CONNECTED_KEY) === 'true'
}
