import React, { useEffect, useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { loadBeeUrl, loadRoomCreator, loadRoomKey, loadStamp, loadUsername } from '../utils/localStorage'
import { DocType } from '../utils/types'
import { consumeInviteFromUrl } from '../utils/url'

const App: React.FC = () => {
  const { session, sessionId, identity, login, logout } = useSession()

  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
  const [roomKey, setRoomKey] = useState(loadRoomKey())
  // Empty until an invite is accepted or one is minted here; whoever mints it is the creator.
  const [roomCreator, setRoomCreator] = useState(loadRoomCreator() || identity)
  const [stamp, setStamp] = useState(loadStamp())
  const [username, setUsername] = useState(loadUsername())
  const [docType, setDocType] = useState<DocType>(DocType.Document)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  // Pasting an invite into a tab that already has the app open changes only the fragment, which
  // navigates nowhere and reloads nothing. Without this the link would appear to do nothing at all.
  useEffect(() => {
    const onHashChange = () => {
      const invite = consumeInviteFromUrl()

      if (!invite) return

      setRoomKey(invite.key)
      setRoomCreator(invite.creator)

      if (invite.docType) setDocType(invite.docType as DocType)
    }

    window.addEventListener('hashchange', onHashChange)

    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (!isLoggedIn || !session) {
    return (
      <LoginView
        // Remounted when the room changes, so the transport and doc-type tabs re-read the values
        // an accepted invite just stored rather than keeping the ones from the previous room.
        key={roomKey}
        username={username}
        beeUrl={beeUrl}
        stamp={stamp}
        roomKey={roomKey}
        identity={identity}
        onBeeUrlChange={setBeeUrl}
        onStampChange={setStamp}
        onRoomChange={(key, creator) => {
          setRoomKey(key)
          setRoomCreator(creator)
        }}
        onLogin={opts => {
          login(opts)
          setUsername(opts.username)
          setDocType(opts.docType)
          setIsLoggedIn(true)
        }}
      />
    )
  }

  return (
    <SessionView
      session={session}
      sessionId={sessionId}
      beeUrl={beeUrl}
      roomKey={roomKey}
      roomCreator={roomCreator}
      stamp={stamp}
      docType={docType}
      onBeeUrlChange={setBeeUrl}
      onStampChange={setStamp}
      onLogout={() => {
        setIsLoggedIn(false)
        logout()
      }}
    />
  )
}

export default App
