import { PrivateKey } from '@ethersphere/bee-js'
import {
  createSwarmPubSubTransport,
  createSwarmRtcTransport,
  createWakuTransport,
  createYWebrtcTransport,
  DocSettings,
  PLACEHOLDER_STAMP,
} from 'lib'
import { Copy, FileText, LogOut, RefreshCw, Settings, Users } from 'lucide-react'
import React, { ReactNode, useCallback, useMemo, useState } from 'react'

import { useSwarmDoc } from '../../hooks/useSwarmDoc'
import {
  BEE_URL_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_TOPIC,
  MUTABLE_STAMP_KEY,
  TOPIC_KEY,
} from '../../utils/constants'
import { colorForAddress } from '../../utils/peers'
import { DocType, Session, Transport, TRANSPORT_LABELS } from '../../utils/types'
import { DocEditor } from '../DocEditor/DocEditor'
import { MonacoEditor } from '../MonacoEditor/MonacoEditor'

import './SessionView.scss'

interface SessionViewProps {
  session: Session
  beeUrl: string
  mutableStamp: string
  topic: string
  docType: DocType
  disableUntilConnected: boolean
  onBeeUrlChange: (url: string) => void
  onMutableStampChange: (v: string) => void
  onTopicChange: (v: string) => void
  onLogout: () => void
}

export const SessionView: React.FC<SessionViewProps> = ({
  session,
  beeUrl,
  mutableStamp,
  topic,
  docType,
  disableUntilConnected,
  onBeeUrlChange,
  onMutableStampChange,
  onTopicChange,
  onLogout,
}) => {
  const signer = useMemo(() => new PrivateKey(session.privKey), [session.privKey])
  const [configOpen, setConfigOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState(beeUrl)
  const [topicDraft, setTopicDraft] = useState(topic)
  const [mutableStampDraft, setMutableStampDraft] = useState(mutableStamp)

  const applyConfig = () => {
    const trimmedUrl = urlDraft.trim()

    if (trimmedUrl) {
      localStorage.setItem(BEE_URL_KEY, trimmedUrl)
      onBeeUrlChange(trimmedUrl)
    }
    localStorage.setItem(MUTABLE_STAMP_KEY, mutableStampDraft)
    onMutableStampChange(mutableStampDraft)
    localStorage.setItem(TOPIC_KEY, topicDraft)
    onTopicChange(topicDraft)
    setConfigOpen(false)
  }

  const docConfig: DocSettings = useMemo(() => {
    const getTransport = () => {
      if (session.transport === Transport.WAKU) {
        let wakuAddress: string[] | undefined = undefined

        if (session.wakuAddress) {
          wakuAddress = [session.wakuAddress]
        }

        return createWakuTransport(wakuAddress)
      }

      if (session.transport === Transport.SWARM_PUBSUB) {
        return createSwarmPubSubTransport(session.brokerPeer ?? '')
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
        mutableStamp,
        topic,
        transport: getTransport(),
      },
    }
  }, [
    session.username,
    session.brokerPeer,
    session.transport,
    session.signalingUrl,
    session.stunUrl,
    session.wakuAddress,
    signer,
    topic,
    beeUrl,
    mutableStamp,
  ])

  const { doc, error, members, connected, awareness, updateCursor, refreshMemberList, dismissError } =
    useSwarmDoc(docConfig)

  const transportLabel = TRANSPORT_LABELS[session.transport]

  const editorBlock = () => {
    return (
      <div className="session-view__doc-block">
        {error ? (
          <div className="session-view__error-bar">
            Doc error: {error?.message}
            <button onClick={dismissError} style={{ padding: 8 }}>
              {'Dismiss'}
            </button>
          </div>
        ) : null}
        {doc &&
          (docType === DocType.Code ? (
            <MonacoEditor
              yDoc={doc}
              disabled={disableUntilConnected && !connected}
              awareness={awareness}
              onCursorChange={updateCursor}
            />
          ) : (
            <DocEditor
              yDoc={doc}
              disabled={disableUntilConnected && !connected}
              awareness={awareness}
              onCursorChange={updateCursor}
            />
          ))}
      </div>
    )
  }

  const memberList = useCallback((): ReactNode | null => {
    if (!members) return null

    const block: ReactNode[] = []

    for (const [addr, username] of members) {
      block.push(
        <span key={addr} className="session-view__member-chip">
          <span
            className="session-view__member-dot"
            aria-hidden="true"
            style={{ background: colorForAddress(addr), boxShadow: `0 0 0 2px ${colorForAddress(addr)}33` }}
          />
          <code className="session-view__member-code" title={addr}>
            {username.length ? username : addr.slice(0, 8) + '…'}
          </code>
        </span>,
      )
    }

    return block
  }, [members])

  return (
    <div className="session-view">
      {/* Header */}
      <div className="session-view__header">
        <div className="session-view__header-row">
          <div className="session-view__logo" aria-hidden="true">
            <FileText size={15} strokeWidth={2.25} />
          </div>
          <span className="session-view__username">{session.username}</span>
          <code className="session-view__pubkey" title={session.pubKey}>
            {session.pubKey.slice(0, 8)}
          </code>
          <button
            className="session-view__btn"
            title="Copy address"
            onClick={() => navigator.clipboard.writeText(session.pubKey)}
          >
            <Copy size={13} />
            Copy
          </button>
          <span className="session-view__transport-badge">{transportLabel}</span>

          {members && members.size > 0 && (
            <div className="session-view__members">
              <span className="session-view__members-label">
                <Users size={12} />
                {members.size}
              </span>
              {memberList()}
            </div>
          )}

          <button
            onClick={refreshMemberList}
            className="session-view__btn session-view__btn--refresh"
            title="Re-read member list"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
          <button
            onClick={() => {
              setUrlDraft(beeUrl)
              setMutableStampDraft(mutableStamp)
              setTopicDraft(topic)
              setConfigOpen(o => !o)
            }}
            className={`session-view__btn session-view__btn--config${configOpen ? ' session-view__btn--config-open' : ''}`}
            style={members?.size === 0 ? { marginLeft: 'auto' } : undefined}
            title="Bee node settings"
          >
            <Settings size={13} />
            Bee
          </button>
          <button onClick={onLogout} className="session-view__btn session-view__btn--logout" title="Logout">
            <LogOut size={13} />
            Logout
          </button>
        </div>

        {/* Config panel */}
        {configOpen && (
          <div className="session-view__config-panel">
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
                  label: 'Postage stamp',
                  value: mutableStampDraft,
                  onChange: setMutableStampDraft,
                  placeholder: PLACEHOLDER_STAMP,
                  mono: true,
                  onReset: () => setMutableStampDraft(PLACEHOLDER_STAMP),
                },
                {
                  label: 'Topic',
                  value: topicDraft,
                  onChange: setTopicDraft,
                  placeholder: DEFAULT_TOPIC,
                  mono: true,
                  onReset: () => setTopicDraft(DEFAULT_TOPIC),
                },
              ] as const
            ).map(({ label, value, onChange, placeholder, mono, onReset }) => (
              <div key={label} className="session-view__config-field">
                <label className="session-view__config-label">{label}</label>
                <input
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyConfig()}
                  placeholder={placeholder}
                  className={`session-view__config-input${mono ? ' session-view__config-input--mono' : ''}`}
                  autoFocus={label === 'Bee API URL'}
                />
                <button onClick={onReset} className="session-view__config-reset" title="Reset to default">
                  Reset
                </button>
              </div>
            ))}
            <div className="session-view__config-actions">
              <button onClick={applyConfig} className="session-view__config-apply">
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Doc */}
      <div className="session-view__doc">{editorBlock()}</div>
    </div>
  )
}
