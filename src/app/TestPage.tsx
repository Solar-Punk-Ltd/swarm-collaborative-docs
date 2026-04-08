import { PrivateKey } from '@ethersphere/bee-js'
import {
  BroadcastChannelNotificationProvider,
  getSigner,
  NotificationProvider,
  SwarmFeedNotificationProvider,
  uuidV4,
} from 'lib'
import React, { useMemo, useState } from 'react'

import { DocEditor } from './components/DocEditor/DocEditor'
import { useSwarmDoc } from './hooks/useSwarmDoc'

enum Transport {
  SWARM = 'swarm',
  BROADCAST = 'broadcast',
}

const DEFAULT_BEE_URL = process.env.BEE_API_URL || 'http://localhost:1633'
const BEE_URL_KEY = 'bee_url'

const DEFAULT_STAMP = process.env.STAMP ?? ''
const DEFAULT_MUTABLE_STAMP = process.env.MUTABLE_STAMP ?? ''

const STAMP_KEY = 'stamp'
const MUTABLE_STAMP_KEY = 'mutable_stamp'

function loadBeeUrl(): string {
  return sessionStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_URL
}

function loadStamp(): string {
  return sessionStorage.getItem(STAMP_KEY) ?? DEFAULT_STAMP
}

function loadMutableStamp(): string {
  return sessionStorage.getItem(MUTABLE_STAMP_KEY) ?? DEFAULT_MUTABLE_STAMP
}

function getTopic(id: string): string {
  return id + (process.env.ENV ?? 'dev')
}

const TEST_SESSION_ID = 'test-room'
const SESSION_KEY = 'test_session'

interface TestSession {
  username: string
  privKey: string
  pubKey: string
  transport: Transport
}

function createSession(username: string, transport: Transport): TestSession {
  const id = uuidV4()
  const signer = getSigner(id)

  return {
    username,
    privKey: signer.toHex(),
    pubKey: signer.publicKey().address().toString(),
    transport,
  }
}

function loadSession(): TestSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)

    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const SessionView: React.FC<{
  session: TestSession
  beeUrl: string
  stamp: string
  mutableStamp: string
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onMutableStampChange: (v: string) => void
  onLogout: () => void
}> = ({ session, beeUrl, stamp, mutableStamp, onBeeUrlChange, onStampChange, onMutableStampChange, onLogout }) => {
  const signer = useMemo(() => new PrivateKey(session.privKey), [session.privKey])
  const topic = getTopic(TEST_SESSION_ID)
  const [configOpen, setConfigOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState(beeUrl)
  const [stampDraft, setStampDraft] = useState(stamp)
  const [mutableStampDraft, setMutableStampDraft] = useState(mutableStamp)

  const applyConfig = () => {
    const trimmedUrl = urlDraft.trim()

    if (trimmedUrl) {
      sessionStorage.setItem(BEE_URL_KEY, trimmedUrl)
      onBeeUrlChange(trimmedUrl)
    }
    sessionStorage.setItem(STAMP_KEY, stampDraft)
    onStampChange(stampDraft)
    sessionStorage.setItem(MUTABLE_STAMP_KEY, mutableStampDraft)
    onMutableStampChange(mutableStampDraft)
    setConfigOpen(false)
  }

  const notificationProvider = useMemo((): NotificationProvider => {
    if (session.transport === Transport.BROADCAST) {
      return new BroadcastChannelNotificationProvider()
    }

    return new SwarmFeedNotificationProvider(beeUrl, signer.toHex(), mutableStamp, topic)
  }, [session.transport, beeUrl, signer, topic, mutableStamp])

  const docConfig = useMemo(
    () => ({
      user: { nickname: session.username, privateKey: signer.toHex() },
      infra: {
        beeUrl,
        stamp,
        mutableStamp,
        topic,
        notificationProvider,
      },
    }),
    [session.username, signer, topic, beeUrl, stamp, mutableStamp, notificationProvider],
  )

  const { doc, error, members, refreshManifest } = useSwarmDoc(docConfig)

  const transportLabel = session.transport === Transport.BROADCAST ? 'BroadcastChannel' : 'Swarm Feed'

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: '#222', color: '#fff', fontSize: 13 }}>
        <div
          style={{
            padding: '8px 16px',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <strong>{session.username}</strong>
          <code style={{ fontSize: 11, opacity: 0.6 }}>{session.pubKey}</code>
          <button
            onClick={() => navigator.clipboard.writeText(session.pubKey)}
            style={{ fontSize: 11, padding: '2px 6px' }}
            title="Copy address"
          >
            Copy address
          </button>
          <span
            style={{
              fontSize: 11,
              opacity: 0.5,
              padding: '1px 6px',
              border: '1px solid #555',
              borderRadius: 3,
            }}
          >
            {transportLabel}
          </span>

          {members.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                marginLeft: 'auto',
              }}
            >
              {members.map(m => (
                <span
                  key={m}
                  style={{
                    background: '#333',
                    borderRadius: 3,
                    padding: '1px 6px',
                    fontSize: 11,
                  }}
                >
                  <code style={{ opacity: 0.8 }}>{m.slice(0, 8)}…</code>
                </span>
              ))}
            </div>
          )}

          <button
            onClick={refreshManifest}
            style={{ fontSize: 11, padding: '2px 6px', opacity: 0.7 }}
            title="Re-read member manifest"
          >
            Refresh Members
          </button>
          <button
            onClick={() => {
              setUrlDraft(beeUrl)
              setStampDraft(stamp)
              setMutableStampDraft(mutableStamp)
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

        {/* Config row */}
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label
                style={{
                  fontSize: 11,
                  opacity: 0.7,
                  whiteSpace: 'nowrap',
                  width: 160,
                }}
              >
                Bee API URL
              </label>
              <input
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applyConfig()}
                style={{
                  flex: 1,
                  padding: '3px 6px',
                  fontSize: 12,
                  background: '#111',
                  color: '#fff',
                  border: '1px solid #555',
                  borderRadius: 3,
                }}
                autoFocus
              />
              <button
                onClick={() => setUrlDraft(DEFAULT_BEE_URL)}
                style={{ fontSize: 11, padding: '3px 8px', opacity: 0.6 }}
                title="Reset to default"
              >
                Reset
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label
                style={{
                  fontSize: 11,
                  opacity: 0.7,
                  whiteSpace: 'nowrap',
                  width: 160,
                }}
              >
                STAMP
              </label>
              <input
                value={stampDraft}
                onChange={e => setStampDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applyConfig()}
                placeholder={DEFAULT_STAMP || 'batch stamp hex'}
                style={{
                  flex: 1,
                  padding: '3px 6px',
                  fontSize: 12,
                  background: '#111',
                  color: '#fff',
                  border: '1px solid #555',
                  borderRadius: 3,
                  fontFamily: 'monospace',
                }}
              />
              <button
                onClick={() => setStampDraft(DEFAULT_STAMP)}
                style={{ fontSize: 11, padding: '3px 8px', opacity: 0.6 }}
                title="Reset to .env value"
              >
                Reset
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label
                style={{
                  fontSize: 11,
                  opacity: 0.7,
                  whiteSpace: 'nowrap',
                  width: 160,
                }}
              >
                MUTABLE_STAMP
              </label>
              <input
                value={mutableStampDraft}
                onChange={e => setMutableStampDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applyConfig()}
                placeholder={DEFAULT_MUTABLE_STAMP || 'mutable stamp hex'}
                style={{
                  flex: 1,
                  padding: '3px 6px',
                  fontSize: 12,
                  background: '#111',
                  color: '#fff',
                  border: '1px solid #555',
                  borderRadius: 3,
                  fontFamily: 'monospace',
                }}
              />
              <button
                onClick={() => setMutableStampDraft(DEFAULT_MUTABLE_STAMP)}
                style={{ fontSize: 11, padding: '3px 8px', opacity: 0.6 }}
                title="Reset to .env value"
              >
                Reset
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={applyConfig} style={{ fontSize: 11, padding: '3px 10px' }}>
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Doc */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {error ? (
          <div style={{ padding: 16, color: '#f87171' }}>Doc error: {error?.message}</div>
        ) : (
          <DocEditor doc={doc} />
        )}
      </div>
    </div>
  )
}

const TestPage: React.FC = () => {
  const [session, setSession] = useState<TestSession | null>(loadSession)
  const [inputName, setInputName] = useState('')
  const [transport, setTransport] = useState<Transport>(Transport.SWARM)
  const [beeUrl, setBeeUrl] = useState(loadBeeUrl)
  const [stamp, setStamp] = useState(loadStamp)
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp)

  const login = (name: string) => {
    const s = createSession(name, transport)
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    setSession(s)
  }

  const logout = () => {
    sessionStorage.removeItem(SESSION_KEY)
    setSession(null)
  }

  if (!session) {
    return (
      <div
        style={{
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: 400,
        }}
      >
        <h2 style={{ margin: 0 }}>Swarm Collab Doc</h2>
        <input
          value={inputName}
          onChange={e => setInputName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && inputName.trim() && login(inputName.trim())}
          placeholder="Enter username"
          style={{ padding: 8, fontSize: 16 }}
          autoFocus
        />
        <div
          style={{
            display: 'flex',
            gap: 0,
            borderRadius: 4,
            overflow: 'hidden',
            border: '1px solid #555',
          }}
        >
          <button
            onClick={() => setTransport(Transport.SWARM)}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 13,
              border: 'none',
              cursor: 'pointer',
              background: transport === Transport.SWARM ? '#4f8ef7' : '#2a2a2a',
              color: transport === Transport.SWARM ? '#fff' : '#aaa',
            }}
          >
            Swarm Feed
          </button>
          <button
            onClick={() => setTransport(Transport.BROADCAST)}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 13,
              border: 'none',
              cursor: 'pointer',
              background: transport === Transport.BROADCAST ? '#4f8ef7' : '#2a2a2a',
              color: transport === Transport.BROADCAST ? '#fff' : '#aaa',
            }}
          >
            BroadcastChannel
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.6 }}>Bee API URL</label>
          <input
            value={beeUrl}
            onChange={e => setBeeUrl(e.target.value)}
            onBlur={() => sessionStorage.setItem(BEE_URL_KEY, beeUrl)}
            placeholder={DEFAULT_BEE_URL}
            style={{ padding: 6, fontSize: 13 }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.6 }}>STAMP</label>
          <input
            value={stamp}
            onChange={e => setStamp(e.target.value)}
            onBlur={() => sessionStorage.setItem(STAMP_KEY, stamp)}
            placeholder={DEFAULT_STAMP || 'batch stamp hex'}
            style={{ padding: 6, fontSize: 13, fontFamily: 'monospace' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.6 }}>MUTABLE_STAMP</label>
          <input
            value={mutableStamp}
            onChange={e => setMutableStamp(e.target.value)}
            onBlur={() => sessionStorage.setItem(MUTABLE_STAMP_KEY, mutableStamp)}
            placeholder={DEFAULT_MUTABLE_STAMP || 'mutable stamp hex'}
            style={{ padding: 6, fontSize: 13, fontFamily: 'monospace' }}
          />
        </div>
        <button onClick={() => login(inputName.trim())} disabled={!inputName.trim()} style={{ padding: 8 }}>
          Join
        </button>
      </div>
    )
  }

  return (
    <SessionView
      session={session}
      beeUrl={beeUrl}
      stamp={stamp}
      mutableStamp={mutableStamp}
      onBeeUrlChange={setBeeUrl}
      onStampChange={setStamp}
      onMutableStampChange={setMutableStamp}
      onLogout={logout}
    />
  )
}

export default TestPage
