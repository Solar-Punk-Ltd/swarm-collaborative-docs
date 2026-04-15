import { PrivateKey } from '@ethersphere/bee-js'
import {
  createBroadcastChannelTransport,
  createSwarmFeedTransport,
  createSwarmRtcTransport,
  createYWebrtcTransport,
  DEFAULT_ICE_SERVER_URL,
  DocSettings,
  PLACEHOLDER_STAMP,
  validateStamps,
} from 'lib'
import React, { useCallback, useMemo, useState } from 'react'

import { DEFAULT_BEE_API_URL, DEFAULT_SIGNALING_SERVER_URL, DEFAULT_TOPIC } from '../lib/utils/constants'

import { DocEditor } from './components/DocEditor/DocEditor'
import { Session, Transport, useSession } from './hooks/useSession'
import { useSwarmDoc } from './hooks/useSwarmDoc'

const TOPIC_KEY = 'topic'
const BEE_URL_KEY = 'bee_url'
const STAMP_KEY = 'stamp'
const MUTABLE_STAMP_KEY = 'mutable_stamp'
const SIGNALING_URL_KEY = 'signaling_url'
const STUN_URL_KEY = 'stun_url'
const DISABLE_UNTIL_CONNECTED_KEY = 'disable_until_connected'

function loadBeeUrl(): string {
  return localStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_API_URL
}

function loadStamp(): string {
  return localStorage.getItem(STAMP_KEY) ?? PLACEHOLDER_STAMP
}

function loadTopic(): string {
  return localStorage.getItem(TOPIC_KEY) ?? DEFAULT_TOPIC
}

function loadMutableStamp(): string {
  return localStorage.getItem(MUTABLE_STAMP_KEY) ?? PLACEHOLDER_STAMP
}

function loadSignalingUrl(): string {
  return localStorage.getItem(SIGNALING_URL_KEY) ?? DEFAULT_SIGNALING_SERVER_URL
}

function loadStunUrl(): string {
  return localStorage.getItem(STUN_URL_KEY) ?? DEFAULT_ICE_SERVER_URL
}

function loadDisableUntilConnected(): boolean {
  return localStorage.getItem(DISABLE_UNTIL_CONNECTED_KEY) === 'true'
}

// ── LoginView ─────────────────────────────────────────────────────────────────

interface LoginViewProps {
  username?: string
  beeUrl: string
  stamp: string
  mutableStamp: string
  topic: string
  disableUntilConnected: boolean
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onMutableStampChange: (v: string) => void
  onTopicChange: (v: string) => void
  onDisableUntilConnectedChange: (v: boolean) => void
  onLogin: (username: string, transport: Transport, topic: string, signalingUrl?: string, stunUrl?: string) => void
}

const TRANSPORT_LABELS: Record<Transport, string> = {
  [Transport.SWARM]: 'Swarm Feed',
  [Transport.BROADCAST]: 'BroadcastChannel',
  [Transport.WEBRTC]: 'WebRTC',
}

enum WebrtcMode {
  SIGNALING = 'signaling',
  SWARM = 'swarm',
}

const LoginView: React.FC<LoginViewProps> = ({
  username,
  beeUrl,
  stamp,
  mutableStamp,
  topic,
  disableUntilConnected,
  onBeeUrlChange,
  onStampChange,
  onMutableStampChange,
  onTopicChange,
  onDisableUntilConnectedChange,
  onLogin,
}) => {
  const [inputName, setInputName] = useState(username ?? '')
  const [transport, setTransport] = useState<Transport>(Transport.WEBRTC)
  const [serverUrl, setServerUrl] = useState(loadStunUrl() || DEFAULT_ICE_SERVER_URL)
  const [webrtcMode, setWebrtcMode] = useState<WebrtcMode>(loadSignalingUrl() ? WebrtcMode.SIGNALING : WebrtcMode.SWARM)
  const [validating, setValidating] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const submit = async () => {
    const name = inputName.trim()

    if (!name) return

    if (transport === Transport.WEBRTC) {
      if (!serverUrl) {
        setPageError('Either STUN or Signaling server URL must be set!')
        setValidating(false)

        return
      }
    }

    setPageError(null)
    setValidating(true)

    try {
      await validateStamps(beeUrl, stamp, mutableStamp)
    } catch (err) {
      setPageError((err as Error).message)
      setValidating(false)

      return
    }

    setValidating(false)

    let signalingUrl: string | undefined = undefined
    let stunUrl: string | undefined = undefined

    if (webrtcMode === WebrtcMode.SIGNALING) {
      signalingUrl = serverUrl
      localStorage.setItem(STUN_URL_KEY, '')
    } else {
      stunUrl = serverUrl
      localStorage.setItem(SIGNALING_URL_KEY, '')
    }

    onLogin(name, transport, topic, signalingUrl, stunUrl)
  }

  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400 }}>
      <h2 style={{ margin: 0 }}>Swarm Collab Doc</h2>
      <input
        value={inputName}
        onChange={e => setInputName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder={username ?? 'Enter username'}
        style={{ padding: 8, fontSize: 16 }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid #555' }}>
        {([Transport.SWARM, Transport.BROADCAST, Transport.WEBRTC] as const).map(t => (
          <button
            key={t}
            onClick={() => setTransport(t)}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 13,
              border: 'none',
              cursor: 'pointer',
              background: transport === t ? '#4f8ef7' : '#2a2a2a',
              color: transport === t ? '#fff' : '#aaa',
            }}
          >
            {TRANSPORT_LABELS[t]}
          </button>
        ))}
      </div>
      {transport === Transport.WEBRTC && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid #555' }}>
            {([WebrtcMode.SIGNALING, WebrtcMode.SWARM] as const).map(mode => (
              <button
                key={mode}
                onClick={() => {
                  setWebrtcMode(mode)
                  const itemKey = mode === WebrtcMode.SIGNALING ? SIGNALING_URL_KEY : STUN_URL_KEY
                  localStorage.setItem(itemKey, '')
                }}
                style={{
                  flex: 1,
                  padding: '6px 0',
                  fontSize: 13,
                  border: 'none',
                  cursor: 'pointer',
                  background: webrtcMode === mode ? '#4f8ef7' : '#2a2a2a',
                  color: webrtcMode === mode ? '#fff' : '#aaa',
                }}
              >
                {mode === WebrtcMode.SIGNALING ? 'Signaling Server URL' : 'Swarm Signaling STUN URL '}
              </button>
            ))}
          </div>
          {
            <input
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              onBlur={() =>
                localStorage.setItem(webrtcMode === WebrtcMode.SIGNALING ? SIGNALING_URL_KEY : STUN_URL_KEY, serverUrl)
              }
              placeholder={webrtcMode === WebrtcMode.SIGNALING ? DEFAULT_SIGNALING_SERVER_URL : DEFAULT_ICE_SERVER_URL}
              style={{ padding: 6, fontSize: 13, fontFamily: 'monospace' }}
            />
          }
        </div>
      )}
      {(
        [
          {
            key: BEE_URL_KEY,
            label: 'Bee API URL',
            value: beeUrl,
            onChange: onBeeUrlChange,
            placeholder: DEFAULT_BEE_API_URL,
            mono: false,
          },
          {
            key: STAMP_KEY,
            label: 'STAMP',
            value: stamp,
            onChange: onStampChange,
            placeholder: PLACEHOLDER_STAMP,
            mono: true,
          },
          {
            key: MUTABLE_STAMP_KEY,
            label: 'MUTABLE_STAMP',
            value: mutableStamp,
            onChange: onMutableStampChange,
            placeholder: PLACEHOLDER_STAMP,
            mono: true,
          },
          {
            key: TOPIC_KEY,
            label: 'TOPIC',
            value: topic,
            onChange: onTopicChange,
            placeholder: DEFAULT_TOPIC,
            mono: true,
          },
        ] as const
      ).map(({ key, label, value, onChange, placeholder, mono }) => (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.6 }}>{label}</label>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={() => localStorage.setItem(key, value)}
            placeholder={placeholder}
            style={{ padding: 6, fontSize: 13, ...(mono ? { fontFamily: 'monospace' } : {}) }}
          />
          {mono && (!value || value === PLACEHOLDER_STAMP) && (
            <span style={{ fontSize: 11, color: '#fbbf24' }}>
              ⚠ No stamp set — uploads will rely on a smart gateway
            </span>
          )}
        </div>
      ))}
      {pageError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: '#f87171',
            padding: '6px 10px',
            background: '#2a1010',
            borderRadius: 4,
          }}
        >
          <span style={{ flex: 1 }}>⚠ {pageError}</span>
        </div>
      )}
      {transport === Transport.WEBRTC && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={disableUntilConnected}
            onChange={e => onDisableUntilConnectedChange(e.target.checked)}
          />
          Disable editing until peer connected
        </label>
      )}
      <button onClick={submit} disabled={!inputName.trim() || validating} style={{ padding: 8 }}>
        {validating ? 'Checking stamps…' : 'Join'}
      </button>
    </div>
  )
}

// ── SessionView ───────────────────────────────────────────────────────────────

interface SessionViewProps {
  session: Session
  beeUrl: string
  stamp: string
  mutableStamp: string
  topic: string
  disableUntilConnected: boolean
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onMutableStampChange: (v: string) => void
  onTopicChange: (v: string) => void
  onLogout: () => void
}

const SessionView: React.FC<SessionViewProps> = ({
  session,
  beeUrl,
  stamp,
  mutableStamp,
  topic,
  disableUntilConnected,
  onBeeUrlChange,
  onStampChange,
  onMutableStampChange,
  onTopicChange,
  onLogout,
}) => {
  const signer = useMemo(() => new PrivateKey(session.privKey), [session.privKey])
  const [configOpen, setConfigOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState(beeUrl)
  const [stampDraft, setStampDraft] = useState(stamp)
  const [topicDraft, setTopicDraft] = useState(topic)
  const [mutableStampDraft, setMutableStampDraft] = useState(mutableStamp)

  const applyConfig = () => {
    const trimmedUrl = urlDraft.trim()

    if (trimmedUrl) {
      localStorage.setItem(BEE_URL_KEY, trimmedUrl)
      onBeeUrlChange(trimmedUrl)
    }
    localStorage.setItem(STAMP_KEY, stampDraft)
    onStampChange(stampDraft)
    localStorage.setItem(MUTABLE_STAMP_KEY, mutableStampDraft)
    onMutableStampChange(mutableStampDraft)
    localStorage.setItem(TOPIC_KEY, topicDraft)
    onTopicChange(topicDraft)
    setConfigOpen(false)
  }

  const docConfig: DocSettings = useMemo(() => {
    const getTransport = () => {
      if (session.transport === Transport.BROADCAST) {
        return createBroadcastChannelTransport()
      }

      if (session.transport === Transport.SWARM) {
        return createSwarmFeedTransport(beeUrl, signer.toHex(), mutableStamp, topic)
      }

      if (session.signalingUrl) {
        return createYWebrtcTransport(session.signalingUrl)
      }

      let stunUrl = session.stunUrl

      if (!stunUrl) {
        stunUrl = DEFAULT_ICE_SERVER_URL
        console.warn(
          `No Transport option was provided, using defualt SwarmRtcTransport with STUN server url: ${stunUrl}`,
        )
      }

      return createSwarmRtcTransport(stunUrl)
    }

    return {
      user: { nickname: session.username, privateKey: signer.toHex() },
      infra: {
        beeUrl,
        stamp,
        mutableStamp,
        topic,
        transport: getTransport(),
      },
    }
  }, [
    session.username,
    session.transport,
    session.signalingUrl,
    session.stunUrl,
    signer,
    topic,
    beeUrl,
    stamp,
    mutableStamp,
  ])

  const { doc, error, members, connected, refreshMemberList, dismissError } = useSwarmDoc(docConfig)

  const transportLabel = TRANSPORT_LABELS[session.transport]

  const displayDocBlock = () => {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        {error ? (
          <div style={{ padding: 16, color: '#f87171' }}>
            Doc error: {error?.message}
            <button onClick={dismissError} style={{ padding: 8 }}>
              {'Dismiss'}
            </button>
          </div>
        ) : null}
        <DocEditor doc={doc} disabled={disableUntilConnected && !connected} />
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: '#222', color: '#fff', fontSize: 13 }}>
        <div style={{ padding: '8px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{session.username}</strong>
          <code style={{ fontSize: 11, opacity: 0.6 }}>{session.pubKey}</code>
          <button
            onClick={() => navigator.clipboard.writeText(session.pubKey)}
            style={{ fontSize: 11, padding: '2px 6px' }}
            title="Copy address"
          >
            Copy address
          </button>
          <span style={{ fontSize: 11, opacity: 0.5, padding: '1px 6px', border: '1px solid #555', borderRadius: 3 }}>
            {transportLabel}
          </span>

          {members.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
              {members.map(m => (
                <span key={m} style={{ background: '#333', borderRadius: 3, padding: '1px 6px', fontSize: 11 }}>
                  <code style={{ opacity: 0.8 }}>{m.slice(0, 8)}…</code>
                </span>
              ))}
            </div>
          )}

          <button
            onClick={refreshMemberList}
            style={{ fontSize: 11, padding: '2px 6px', opacity: 0.7 }}
            title="Re-read member list"
          >
            Refresh Members
          </button>
          <button
            onClick={() => {
              setUrlDraft(beeUrl)
              setStampDraft(stamp)
              setMutableStampDraft(mutableStamp)
              setTopicDraft(topic)
              setConfigOpen(o => !o)
            }}
            style={{
              fontSize: 11,
              padding: '2px 6px',
              marginLeft: members.length === 0 ? 'auto' : undefined,
              opacity: configOpen ? 1 : 0.6,
            }}
            title="Bee node settings"
          >
            ⚙ Bee
          </button>
          <button onClick={onLogout} style={{ fontSize: 12, padding: '2px 8px' }}>
            Logout
          </button>
        </div>

        {/* Config panel */}
        {configOpen && (
          <div
            style={{
              padding: '8px 16px',
              borderTop: '1px solid #333',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {(
              [
                {
                  label: 'Bee API URL',
                  value: urlDraft,
                  onChange: setUrlDraft,
                  placeholder: DEFAULT_BEE_API_URL,
                  mono: false,
                  onReset: () => setUrlDraft(DEFAULT_BEE_API_URL),
                },
                {
                  label: 'STAMP',
                  value: stampDraft,
                  onChange: setStampDraft,
                  placeholder: PLACEHOLDER_STAMP,
                  mono: true,
                  onReset: () => setStampDraft(PLACEHOLDER_STAMP),
                },
                {
                  label: 'MUTABLE_STAMP',
                  value: mutableStampDraft,
                  onChange: setMutableStampDraft,
                  placeholder: PLACEHOLDER_STAMP,
                  mono: true,
                  onReset: () => setMutableStampDraft(PLACEHOLDER_STAMP),
                },
                {
                  label: 'TOPIC',
                  value: topicDraft,
                  onChange: setTopicDraft,
                  placeholder: DEFAULT_TOPIC,
                  mono: true,
                  onReset: () => setTopicDraft(DEFAULT_TOPIC),
                },
              ] as const
            ).map(({ label, value, onChange, placeholder, mono, onReset }) => (
              <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap', width: 160 }}>{label}</label>
                <input
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyConfig()}
                  placeholder={placeholder}
                  style={{
                    flex: 1,
                    padding: '3px 6px',
                    fontSize: 12,
                    background: '#111',
                    color: '#fff',
                    border: '1px solid #555',
                    borderRadius: 3,
                    ...(mono ? { fontFamily: 'monospace' } : {}),
                  }}
                  autoFocus={label === 'Bee API URL'}
                />
                <button
                  onClick={onReset}
                  style={{ fontSize: 11, padding: '3px 8px', opacity: 0.6 }}
                  title="Reset to default"
                >
                  Reset
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={applyConfig} style={{ fontSize: 11, padding: '3px 10px' }}>
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Doc */}
      <div style={{ flex: 1, overflow: 'hidden' }}>{displayDocBlock()}</div>
    </div>
  )
}

// ── TestPage ──────────────────────────────────────────────────────────────────

const TestPage: React.FC = () => {
  const { session, login, logout } = useSession()
  const [beeUrl, setBeeUrl] = useState(loadBeeUrl)
  const [stamp, setStamp] = useState(loadStamp)
  const [topic, setTopic] = useState(loadTopic)
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [disableUntilConnected, setDisableUntilConnected] = useState(loadDisableUntilConnected)

  const handleDisableUntilConnectedChange = useCallback(
    (v: boolean) => {
      if (session?.transport === Transport.WEBRTC) {
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
        onLogin={(username, transport, topic, signalingUrl, stunUrl) => {
          login(username, transport, topic, signalingUrl, stunUrl)
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
