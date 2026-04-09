import { getSigner, uuidV4 } from 'lib'
import { useState } from 'react'

export enum Transport {
  SWARM = 'swarm',
  BROADCAST = 'broadcast',
}

export interface Session {
  username: string
  privKey: string
  pubKey: string
  transport: Transport
}

const SESSION_KEY = 'test_session'

function createSession(username: string, transport: Transport): Session {
  const signer = getSigner(uuidV4())

  return {
    username,
    privKey: signer.toHex(),
    pubKey: signer.publicKey().address().toString(),
    transport,
  }
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)

    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(loadSession)

  const login = (username: string, transport: Transport) => {
    const s = createSession(username, transport)
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    setSession(s)
  }

  const logout = () => {
    sessionStorage.removeItem(SESSION_KEY)
    setSession(null)
  }

  return { session, login, logout }
}
