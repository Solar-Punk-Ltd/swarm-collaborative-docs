import { getSigner, uuidV4 } from 'lib'
import { useState } from 'react'

import { SESSION_KEY } from '../utils/constants'
import { Session, Transport } from '../utils/types'

function createSession(
  username: string,
  transport: Transport,
  topic: string,
  signalingUrl?: string,
  stunUrl?: string,
  wakuAddress?: string,
): Session {
  const existing = loadSession()

  if (existing?.privKey && existing?.pubKey) {
    return {
      username,
      privKey: existing.privKey,
      pubKey: existing.pubKey,
      topic,
      transport,
      signalingUrl,
      stunUrl,
      wakuAddress,
    }
  }

  const signer = getSigner(uuidV4())

  return {
    username,
    privKey: signer.toHex(),
    pubKey: signer.publicKey().address().toString(),
    topic,
    transport,
    signalingUrl,
    stunUrl,
    wakuAddress,
  }
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)

    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(loadSession)

  const login = (
    username: string,
    transport: Transport,
    topic: string,
    signalingUrl?: string,
    stunUrl?: string,
    wakuAddress?: string,
  ) => {
    const s = createSession(username, transport, topic, signalingUrl, stunUrl, wakuAddress)
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    setSession(s)
  }

  const logout = () => {
    setSession(null)
  }

  return { session, login, logout }
}
