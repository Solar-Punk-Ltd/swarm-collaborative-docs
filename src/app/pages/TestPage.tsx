import React, { useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { DISABLE_UNTIL_CONNECTED_KEY, TOPIC_KEY, TRANSPORT_KEY } from '../utils/constants'
import { loadBeeUrl, loadDisableUntilConnected, loadMutableStamp, loadTopic, loadUsername } from '../utils/localStorage'

const TestPage: React.FC = () => {
  const { session, login, logout } = useSession()

  const docIdParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('doc') : null
  const transportParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('trans') : null

  if (transportParam) {
    localStorage.setItem(TRANSPORT_KEY, transportParam)
  }

  if (docIdParam) {
    localStorage.setItem(TOPIC_KEY, docIdParam)
  }

  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
  const [topic, setTopic] = useState(loadTopic())
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp())
  const [username, setUsername] = useState(loadUsername())
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
        onLogin={(username, transport, topic, signalingUrl, stunUrl, wakuAddress, brokerPeer) => {
          login(username, transport, topic, signalingUrl, stunUrl, wakuAddress, brokerPeer)
          setUsername(username)
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

export default TestPage
