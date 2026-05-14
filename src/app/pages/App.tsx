import React, { useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { DISABLE_UNTIL_CONNECTED_KEY } from '../utils/constants'
import { loadBeeUrl, loadDisableUntilConnected, loadMutableStamp, loadTopic, loadUsername } from '../utils/localStorage'
import { DocType } from '../utils/types'

const App: React.FC = () => {
  const { session, login, logout } = useSession()

  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
  const [topic, setTopic] = useState(loadTopic())
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp())
  const [username, setUsername] = useState(loadUsername())
  const [docType, setDocType] = useState<DocType>(DocType.Document)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [disableUntilConnected, setDisableUntilConnected] = useState(loadDisableUntilConnected())

  const handleDisableUntilConnectedChange = (v: boolean) => {
    setDisableUntilConnected(v)
    localStorage.setItem(DISABLE_UNTIL_CONNECTED_KEY, String(v))
  }

  if (!isLoggedIn || !session) {
    return (
      <LoginView
        username={username}
        beeUrl={beeUrl}
        topic={topic}
        mutableStamp={mutableStamp}
        disableUntilConnected={disableUntilConnected}
        onBeeUrlChange={setBeeUrl}
        onMutableStampChange={setMutableStamp}
        onTopicChange={setTopic}
        onDisableUntilConnectedChange={handleDisableUntilConnectedChange}
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
      mutableStamp={mutableStamp}
      docType={docType}
      disableUntilConnected={disableUntilConnected}
      onBeeUrlChange={setBeeUrl}
      onMutableStampChange={setMutableStamp}
      onTopicChange={setTopic}
      onLogout={() => {
        setIsLoggedIn(false)
        logout()
      }}
    />
  )
}

export default App
