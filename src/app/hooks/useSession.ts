import { uuidV4 } from 'lib'
import { useState } from 'react'

import { DOCTYPE_KEY, SESSION_ID_KEY, SESSION_KEY, TRANSPORT_KEY, USERNAME_KEY } from '../utils/constants'
import { loadIdentity, loadSession } from '../utils/localStorage'
import { Session, SessionOpts } from '../utils/types'

function createSession(opts: SessionOpts): Session {
  const { username, transport, signalingUrl, docType, stunUrl } = { ...opts }
  const signer = loadIdentity()

  return {
    username,
    privKey: signer.toHex(),
    pubKey: signer.publicKey().address().toString(),
    transport,
    docType,
    signalingUrl,
    stunUrl,
  }
}

// sessionStorage, not localStorage: every tab needs its own session id, and it must survive a reload.
function getOrCreateSessionId(): string {
  const existing = sessionStorage.getItem(SESSION_ID_KEY)

  if (existing) return existing

  const sessionId = uuidV4()
  sessionStorage.setItem(SESSION_ID_KEY, sessionId)

  return sessionId
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(loadSession)
  const [sessionId] = useState(getOrCreateSessionId)
  // Resolved before login: an invite link names its creator, and that is this identity.
  const [identity] = useState(() => loadIdentity().publicKey().address().toString())

  const login = (opts: SessionOpts) => {
    const s = createSession(opts)
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    localStorage.setItem(TRANSPORT_KEY, opts.transport)
    localStorage.setItem(DOCTYPE_KEY, opts.docType)
    localStorage.setItem(USERNAME_KEY, opts.username)
    setSession(s)
  }

  // The session id is kept: logging back in rejoins the same session rather than stranding the
  // old one in the member list, and the feed writers resolve their true tail before writing, so
  // picking up feeds this session already wrote is safe.
  const logout = () => {
    setSession(null)
  }

  return { session, sessionId, identity, login, logout }
}
