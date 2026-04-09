import { DOC_EVENTS, DocSettings, SwarmDoc } from 'lib'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'

export const useSwarmDoc = ({ user, infra, notificationProvider }: DocSettings) => {
  const docRef = useRef<SwarmDoc | null>(null)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [{ error, members }, setStatus] = useState<{ error: Error | null; members: string[] }>({
    error: null,
    members: [],
  })

  useEffect(() => {
    if (docRef.current) {
      docRef.current.stop()
      docRef.current = null
    }

    const swarmDoc = new SwarmDoc({ user, infra, notificationProvider })
    docRef.current = swarmDoc

    swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR, (err: Error) => setStatus(s => ({ ...s, error: err })))
    swarmDoc.getEmitter().on(DOC_EVENTS.MEMBERS_UPDATED, (m: string[]) => setStatus(s => ({ ...s, members: m })))

    swarmDoc.start()
    setDoc(swarmDoc.doc)

    return () => {
      swarmDoc.stop()
      docRef.current = null
      setDoc(null)
      setStatus({ error: null, members: [] })
    }
  }, [user, infra, notificationProvider])

  const refreshMemberList = () => {
    docRef.current?.refreshMemberList()
  }

  return { doc, error, members, refreshMemberList }
}
