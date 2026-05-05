import { DOC_EVENTS, DocSettings, SwarmDoc } from 'lib'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'

export interface SwarmDocContext {
  doc: Y.Doc | null
  error: Error | null
  members: Map<string, string> | null
  connected: boolean
  refreshMemberList: () => void
  dismissError: () => void
}

export const useSwarmDoc = ({ user, infra }: DocSettings): SwarmDocContext => {
  const docRef = useRef<SwarmDoc | null>(null)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [{ error, members, connected }, setStatus] = useState<{
    error: Error | null
    members: Map<string, string> | null
    connected: boolean
  }>({
    error: null,
    members: null,
    connected: false,
  })

  const dismissError = () => {
    setStatus(prev => (error ? { ...prev, error: null } : prev))
  }

  useEffect(() => {
    if (docRef.current) {
      docRef.current.stop()
      docRef.current = null
    }

    const swarmDoc = new SwarmDoc({ user, infra })
    docRef.current = swarmDoc

    swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR, (err: Error) => setStatus(s => ({ ...s, error: err })))
    swarmDoc
      .getEmitter()
      .on(DOC_EVENTS.MEMBERS_UPDATED, (m: Map<string, string>) => setStatus(s => ({ ...s, members: m })))
    swarmDoc.getEmitter().on(DOC_EVENTS.PEERS_CONNECTED, () => setStatus(s => ({ ...s, connected: true })))

    swarmDoc.start()
    setDoc(swarmDoc.doc)

    return () => {
      swarmDoc.stop()
      docRef.current = null
      setDoc(null)
      setStatus({ error: null, members: null, connected: false })
    }
  }, [user, infra])

  const refreshMemberList = async () => {
    await docRef.current?.refreshMemberList()
  }

  return { doc, error, members, connected, refreshMemberList, dismissError }
}
