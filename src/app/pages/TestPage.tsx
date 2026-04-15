import React, { useCallback, useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { DISABLE_UNTIL_CONNECTED_KEY } from '../utils/constants'
import { loadBeeUrl, loadDisableUntilConnected, loadMutableStamp, loadStamp, loadTopic } from '../utils/localStorage'
import { Transport } from '../utils/types'

const TestPage: React.FC = () => {
  const { session, login, logout } = useSession()
  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
  const [stamp, setStamp] = useState(loadStamp())
  const [topic, setTopic] = useState(loadTopic())
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp())
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [disableUntilConnected, setDisableUntilConnected] = useState(
    session?.transport !== Transport.SWARM ? loadDisableUntilConnected() : false,
  )

  const handleDisableUntilConnectedChange = useCallback(
    (v: boolean) => {
      if (session?.transport !== Transport.SWARM) {
        setDisableUntilConnected(v)
        localStorage.setItem(DISABLE_UNTIL_CONNECTED_KEY, String(v))
      }
    },
    [session],
  )

  if (!isLoggedIn || !session) {
    return (
      <LoginView
        username={session?.username}
        beeUrl={beeUrl}
        stamp={stamp}
        topic={topic}
        mutableStamp={mutableStamp}
        disableUntilConnected={disableUntilConnected}
        onBeeUrlChange={setBeeUrl}
        onStampChange={setStamp}
        onMutableStampChange={setMutableStamp}
        onTopicChange={setTopic}
        onDisableUntilConnectedChange={handleDisableUntilConnectedChange}
        onLogin={(username, transport, topic, signalingUrl, stunUrl, wakuAddress) => {
          login(username, transport, topic, signalingUrl, stunUrl, wakuAddress)
          setIsLoggedIn(true)
        }}
      />
    )
  }

  return (
    <SessionView
      session={session}
      beeUrl={beeUrl}
      stamp={stamp}
      topic={topic}
      mutableStamp={mutableStamp}
      disableUntilConnected={disableUntilConnected}
      onBeeUrlChange={setBeeUrl}
      onStampChange={setStamp}
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
