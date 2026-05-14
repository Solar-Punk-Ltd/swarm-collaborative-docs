import { getSigner, uuidV4 } from 'lib'
import { useState } from 'react'

import { DOCTYPE_KEY, SESSION_KEY, TRANSPORT_KEY, USERNAME_KEY } from '../utils/constants'
import { loadSession } from '../utils/localStorage'
import { Session, SessionOpts } from '../utils/types'

function createSession(opts: SessionOpts): Session {
  const { username, transport, topic, signalingUrl, docType, stunUrl, wakuAddress, brokerPeer } = { ...opts }

  const existing = loadSession()

  if (existing?.privKey && existing?.pubKey) {
    return {
      username,
      privKey: existing.privKey,
      pubKey: existing.pubKey,
      topic,
      docType,
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
    docType,
    signalingUrl,
    stunUrl,
    wakuAddress,
    brokerPeer,
  }
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(loadSession)

  const login = (opts: SessionOpts) => {
    const s = createSession(opts)
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    localStorage.setItem(TRANSPORT_KEY, opts.transport)
    localStorage.setItem(DOCTYPE_KEY, opts.docType)
    localStorage.setItem(USERNAME_KEY, opts.username)
    setSession(s)
  }

  const logout = () => {
    setSession(null)
  }

  return { session, login, logout }
}
