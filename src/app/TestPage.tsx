import { PrivateKey } from '@ethersphere/bee-js'
import {
  BroadcastChannelNotificationProvider,
  NotificationProvider,
  PLACEHOLDER_STAMP,
  SwarmFeedNotificationProvider,
  validateStamps,
} from 'lib'
import React, { useMemo, useState } from 'react'

import { DocEditor } from './components/DocEditor/DocEditor'
import { Session, Transport, useSession } from './hooks/useSession'
import { useSwarmDoc } from './hooks/useSwarmDoc'

const DEFAULT_BEE_URL = process.env.BEE_API_URL || 'http://localhost:1633'
const DEFAULT_STAMP = process.env.STAMP ?? ''
const DEFAULT_MUTABLE_STAMP = process.env.MUTABLE_STAMP ?? ''

const BEE_URL_KEY = 'bee_url'
const STAMP_KEY = 'stamp'
const MUTABLE_STAMP_KEY = 'mutable_stamp'

const TEST_ROOM_ID = 'test-room'

function getTopic(id: string): string {
  return id + (process.env.ENV ?? 'dev')
}

function loadBeeUrl(): string {
  return sessionStorage.getItem(BEE_URL_KEY) ?? DEFAULT_BEE_URL
}

function loadStamp(): string {
  return sessionStorage.getItem(STAMP_KEY) ?? DEFAULT_STAMP
}

function loadMutableStamp(): string {
  return sessionStorage.getItem(MUTABLE_STAMP_KEY) ?? DEFAULT_MUTABLE_STAMP
}

function makeNotificationProvider(
  transport: Transport,
  beeUrl: string,
  privKey: string,
  mutableStamp: string,
  topic: string,
): NotificationProvider {
  if (transport === Transport.BROADCAST) return new BroadcastChannelNotificationProvider()

  return new SwarmFeedNotificationProvider(beeUrl, privKey, mutableStamp, topic)
}

// ── LoginView ─────────────────────────────────────────────────────────────────

interface LoginViewProps {
  beeUrl: string
  stamp: string
  mutableStamp: string
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onMutableStampChange: (v: string) => void
  onLogin: (username: string, transport: Transport) => void
}

const LoginView: React.FC<LoginViewProps> = ({
  beeUrl,
  stamp,
  mutableStamp,
  onBeeUrlChange,
  onStampChange,
  onMutableStampChange,
  onLogin,
}) => {
  const [inputName, setInputName] = useState('')
  const [transport, setTransport] = useState<Transport>(Transport.SWARM)
  const [validating, setValidating] = useState(false)
  const [stampError, setStampError] = useState<string | null>(null)

  const submit = async () => {
    const name = inputName.trim()

    if (!name) return

    setStampError(null)
    setValidating(true)

    try {
      await validateStamps(beeUrl, stamp, mutableStamp)
    } catch (err) {
      setStampError((err as Error).message)
      setValidating(false)

      return
    }

    setValidating(false)
    onLogin(name, transport)
  }

  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400 }}>
      <h2 style={{ margin: 0 }}>Swarm Collab Doc</h2>
      <input
        value={inputName}
        onChange={e => setInputName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Enter username"
        style={{ padding: 8, fontSize: 16 }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid #555' }}>
        {([Transport.SWARM, Transport.BROADCAST] as const).map(t => (
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
            {t === Transport.SWARM ? 'Swarm Feed' : 'BroadcastChannel'}
          </button>
        ))}
      </div>
      {(
        [
          {
            key: BEE_URL_KEY,
            label: 'Bee API URL',
            value: beeUrl,
            onChange: onBeeUrlChange,
            placeholder: DEFAULT_BEE_URL,
            mono: false,
          },
          {
            key: STAMP_KEY,
            label: 'STAMP',
            value: stamp,
            onChange: onStampChange,
            placeholder: DEFAULT_STAMP || 'batch stamp hex',
            mono: true,
          },
          {
            key: MUTABLE_STAMP_KEY,
            label: 'MUTABLE_STAMP',
            value: mutableStamp,
            onChange: onMutableStampChange,
            placeholder: DEFAULT_MUTABLE_STAMP || 'mutable stamp hex',
            mono: true,
          },
        ] as const
      ).map(({ key, label, value, onChange, placeholder, mono }) => (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.6 }}>{label}</label>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={() => sessionStorage.setItem(key, value)}
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
      {stampError && (
        <div style={{ fontSize: 12, color: '#f87171', padding: '6px 10px', background: '#2a1010', borderRadius: 4 }}>
          ⚠ {stampError}
        </div>
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
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onMutableStampChange: (v: string) => void
  onLogout: () => void
}

const SessionView: React.FC<SessionViewProps> = ({
  session,
  beeUrl,
  stamp,
  mutableStamp,
  onBeeUrlChange,
  onStampChange,
  onMutableStampChange,
  onLogout,
}) => {
  const signer = useMemo(() => new PrivateKey(session.privKey), [session.privKey])
  const topic = getTopic(TEST_ROOM_ID)
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

  const notificationProvider = useMemo(
    () => makeNotificationProvider(session.transport, beeUrl, signer.toHex(), mutableStamp, topic),
    [session.transport, beeUrl, signer, mutableStamp, topic],
  )

  const docConfig = useMemo(
    () => ({
      user: { nickname: session.username, privateKey: signer.toHex() },
      infra: { beeUrl, stamp, mutableStamp, topic },
      notificationProvider,
    }),
    [session.username, signer, topic, beeUrl, stamp, mutableStamp, notificationProvider],
  )

  const { doc, error, members, refreshMemberList } = useSwarmDoc(docConfig)

  const transportLabel = session.transport === Transport.BROADCAST ? 'BroadcastChannel' : 'Swarm Feed'

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
                  placeholder: DEFAULT_BEE_URL,
                  mono: false,
                  onReset: () => setUrlDraft(DEFAULT_BEE_URL),
                },
                {
                  label: 'STAMP',
                  value: stampDraft,
                  onChange: setStampDraft,
                  placeholder: DEFAULT_STAMP || 'batch stamp hex',
                  mono: true,
                  onReset: () => setStampDraft(DEFAULT_STAMP),
                },
                {
                  label: 'MUTABLE_STAMP',
                  value: mutableStampDraft,
                  onChange: setMutableStampDraft,
                  placeholder: DEFAULT_MUTABLE_STAMP || 'mutable stamp hex',
                  mono: true,
                  onReset: () => setMutableStampDraft(DEFAULT_MUTABLE_STAMP),
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

// ── TestPage ──────────────────────────────────────────────────────────────────

const TestPage: React.FC = () => {
  const { session, login, logout } = useSession()
  const [beeUrl, setBeeUrl] = useState(loadBeeUrl)
  const [stamp, setStamp] = useState(loadStamp)
  const [mutableStamp, setMutableStamp] = useState(loadMutableStamp)

  if (!session) {
    return (
      <LoginView
        beeUrl={beeUrl}
        stamp={stamp}
        mutableStamp={mutableStamp}
        onBeeUrlChange={setBeeUrl}
        onStampChange={setStamp}
        onMutableStampChange={setMutableStamp}
        onLogin={login}
      />
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
