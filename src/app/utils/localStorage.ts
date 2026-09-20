import { PrivateKey } from '@ethersphere/bee-js'
import { createRoomKey, getSigner, uuidV4 } from 'lib'

import {
  BEE_URL_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_SIGNALING_SERVER_URL,
  DOCTYPE_KEY,
  IDENTITY_KEY,
  ROOM_CREATOR_KEY,
  ROOM_KEY_KEY,
  SESSION_KEY,
  SIGNALING_URL_KEY,
  STAMP_KEY,
  STUN_URL_KEY,
  TRANSPORT_KEY,
  USERNAME_KEY,
} from './constants'
import { DocType, Session, Transport } from './types'

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)

    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

/**
 * The browser's long-lived identity key, minted on first use.
 *
 * Resolved before login rather than during it, because an invite link names its creator and the
 * creator is this identity.
 */
export function loadIdentity(): PrivateKey {
  const stored = localStorage.getItem(IDENTITY_KEY)

  if (stored) return new PrivateKey(stored)

  const key = getSigner(uuidV4()).toHex()
  localStorage.setItem(IDENTITY_KEY, key)

  return new PrivateKey(key)
}

/** The room this browser is on, minting one on first run so there is always a document to open. */
export function loadRoomKey(): string {
  const stored = localStorage.getItem(ROOM_KEY_KEY)

  if (stored) return stored

  const key = createRoomKey()
  localStorage.setItem(ROOM_KEY_KEY, key)

  return key
}

export function loadRoomCreator(): string {
  return localStorage.getItem(ROOM_CREATOR_KEY) ?? ''
}

export function loadBeeUrl(): string {
  return localStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_API_URL
}

export function loadUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? ''
}

export function loadStamp(): string {
  return localStorage.getItem(STAMP_KEY) ?? ''
}

export function loadSignalingUrl(): string {
  return localStorage.getItem(SIGNALING_URL_KEY) ?? DEFAULT_SIGNALING_SERVER_URL
}

export function loadStunUrl(): string {
  return localStorage.getItem(STUN_URL_KEY) ?? DEFAULT_ICE_SERVER_URL
}

export function loadTransport(): Transport {
  return (localStorage.getItem(TRANSPORT_KEY) as Transport) ?? Transport.SWARM_RTC
}

export function loadDocType(): DocType {
  return (localStorage.getItem(DOCTYPE_KEY) as DocType) ?? DocType.Document
}
