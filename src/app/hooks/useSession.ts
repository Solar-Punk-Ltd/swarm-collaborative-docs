import { getSigner, uuidV4 } from 'lib'
import { useState } from 'react'

import { SESSION_KEY, TRANSPORT_KEY, USERNAME_KEY } from '../utils/constants'
import { loadSession } from '../utils/localStorage'
import { Session, Transport } from '../utils/types'

function createSession(
  username: string,
  transport: Transport,
  topic: string,
  signalingUrl?: string,
  stunUrl?: string,
  wakuAddress?: string,
  brokerPeer?: string,
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
      brokerPeer,
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
    brokerPeer,
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
    brokerPeer?: string,
  ) => {
    const s = createSession(username, transport, topic, signalingUrl, stunUrl, wakuAddress, brokerPeer)
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    localStorage.setItem(TRANSPORT_KEY, transport)
    localStorage.setItem(USERNAME_KEY, username)
    setSession(s)
  }

  const logout = () => {
    setSession(null)
  }

  return { session, login, logout }
}
