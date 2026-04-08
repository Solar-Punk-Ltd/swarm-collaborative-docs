import { DOC_EVENTS, DocSettings, SwarmDoc } from 'lib'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'

export const useSwarmDoc = ({ user, infra }: DocSettings) => {
  const docRef = useRef<SwarmDoc | null>(null)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [error, setError] = useState<any | null>(null)
  const [members, setMembers] = useState<string[]>([])

  useEffect(() => {
    if (docRef.current) {
      docRef.current.stop()
      docRef.current = null
    }

    const swarmDoc = new SwarmDoc({ user, infra })
    docRef.current = swarmDoc

    swarmDoc.getEmitter().on(DOC_EVENTS.DOC_ERROR, (err: any) => setError(err))
    swarmDoc.getEmitter().on(DOC_EVENTS.MANIFEST_UPDATED, (m: string[]) => setMembers(m))

    swarmDoc.start()
    setDoc(swarmDoc.doc)

    return () => {
      swarmDoc.stop()
      docRef.current = null
      setDoc(null)
      setMembers([])
    }
  }, [user, infra])

  const refreshManifest = () => {
    docRef.current?.refreshManifest()
  }

  return { doc, error, members, refreshManifest }
}
