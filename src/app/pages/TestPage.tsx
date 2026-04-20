import React, { useCallback, useState } from 'react'

import { LoginView } from '../components/LoginView/LoginView'
import { SessionView } from '../components/SessionView/SessionView'
import { useSession } from '../hooks/useSession'
import { DISABLE_UNTIL_CONNECTED_KEY } from '../utils/constants'
import { loadBeeUrl, loadDisableUntilConnected, loadMutableStamp, loadTopic } from '../utils/localStorage'
import { Transport } from '../utils/types'

const TestPage: React.FC = () => {
  const { session, login, logout } = useSession()
  const [beeUrl, setBeeUrl] = useState(loadBeeUrl())
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
        topic={topic}
        mutableStamp={mutableStamp}
        disableUntilConnected={disableUntilConnected}
        onBeeUrlChange={setBeeUrl}
        onMutableStampChange={setMutableStamp}
        onTopicChange={setTopic}
        onDisableUntilConnectedChange={handleDisableUntilConnectedChange}
        onLogin={(username, transport, topic, signalingUrl, stunUrl, wakuAddress, brokerPeer) => {
          login(username, transport, topic, signalingUrl, stunUrl, wakuAddress, brokerPeer)
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
