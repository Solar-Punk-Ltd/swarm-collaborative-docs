import React, { useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { loadBeeUrl, loadStamp, loadTopic, loadUsername } from '../utils/localStorage'
import { DocType } from '../utils/types'

const App: React.FC = () => {
  const { session, login, logout } = useSession()

  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
  const [topic, setTopic] = useState(loadTopic())
  const [stamp, setStamp] = useState(loadStamp())
  const [username, setUsername] = useState(loadUsername())
  const [docType, setDocType] = useState<DocType>(DocType.Document)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  if (!isLoggedIn || !session) {
    return (
      <LoginView
        username={username}
        beeUrl={beeUrl}
        topic={topic}
        stamp={stamp}
        onBeeUrlChange={setBeeUrl}
        onStampChange={setStamp}
        onTopicChange={setTopic}
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
      beeUrl={beeUrl}
      topic={topic}
      stamp={stamp}
      docType={docType}
      onBeeUrlChange={setBeeUrl}
      onStampChange={setStamp}
      onTopicChange={setTopic}
      onLogout={() => {
        setIsLoggedIn(false)
        logout()
      }}
    />
  )
}

export default App
