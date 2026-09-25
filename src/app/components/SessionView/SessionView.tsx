import { PrivateKey } from '@ethersphere/bee-js'
import { createSignalingServerTransport, createSwarmRtcTransport, DocSettings, PeerConnectionState } from 'lib'
import { Copy, FileText, Link, Loader2, LogOut, RefreshCw, Settings, Users } from 'lucide-react'
import React, { ReactNode, useCallback, useMemo, useState } from 'react'

import { useSwarmDoc } from '../../hooks/useSwarmDoc'
import { BEE_URL_KEY, DEFAULT_BEE_API_URL, STAMP_KEY } from '../../utils/constants'
import { colorForAddress } from '../../utils/peers'
import { AwarenessState, DocType, Session, Transport, TRANSPORT_LABELS } from '../../utils/types'
import { buildInviteLink } from '../../utils/url'
import { DocEditor } from '../DocEditor/DocEditor'
import { MonacoEditor } from '../MonacoEditor/MonacoEditor'

import './SessionView.scss'

const BUTTON_TIMEOUT_MS = 1500

interface SessionViewProps {
  session: Session
  sessionId: string
  beeUrl: string
  stamp: string
  roomKey: string
  roomCreator: string
  docType: DocType
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onLogout: () => void
}

export const SessionView: React.FC<SessionViewProps> = ({
  session,
  sessionId,
  beeUrl,
  stamp,
  roomKey,
  roomCreator,
  docType,
  onBeeUrlChange,
  onStampChange,
  onLogout,
}) => {
  const signer = useMemo(() => new PrivateKey(session.privKey), [session.privKey])
  const [configOpen, setConfigOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState(beeUrl)
  const [stampDraft, setStampDraft] = useState(stamp)
  const [inviteCopied, setInviteCopied] = useState(false)

  const applyConfig = () => {
    const trimmedUrl = urlDraft.trim()

    if (trimmedUrl) {
      localStorage.setItem(BEE_URL_KEY, trimmedUrl)
      onBeeUrlChange(trimmedUrl)
    }
    localStorage.setItem(STAMP_KEY, stampDraft)
    onStampChange(stampDraft)
    setConfigOpen(false)
  }

  // This is the link participants join with. It carries the room secret, which is what grants
  // access — the document id shown in the header does not.
  const copyInvite = useCallback(async () => {
    const link = buildInviteLink({ key: roomKey, creator: roomCreator, transport: session.transport, docType })

    try {
      await navigator.clipboard.writeText(link)
      setInviteCopied(true)
      setTimeout(() => setInviteCopied(false), BUTTON_TIMEOUT_MS)
    } catch {
      // clipboard denied — nothing useful to show here
    }
  }, [roomKey, roomCreator, session.transport, docType])

  const docConfig: DocSettings = useMemo(() => {
    const getTransport = () => {
      const iceServers: RTCIceServer[] = [{ urls: session.stunUrl }]

      if (session.transport === Transport.SIGNALING_SERVER) {
        return createSignalingServerTransport({ signalingUrl: session.signalingUrl ?? '', iceServers })
      }

      return createSwarmRtcTransport({ iceServers })
    }

    return {
      user: { nickname: session.username, privateKey: signer.toHex(), sessionId },
      infra: {
        beeUrl,
        stamp,
        roomKey,
        roomCreator,
        transport: getTransport(),
      },
    }
  }, [
    sessionId,
    session.username,
    session.transport,
    session.signalingUrl,
    session.stunUrl,
    signer,
    roomKey,
    roomCreator,
    beeUrl,
    stamp,
  ])

  const {
    doc,
    error,
    members,
    peerStates,
    ready,
    synced,
    pendingPeers,
    awareness,
    updateCursor,
    refreshMemberList,
    dismissError,
  } = useSwarmDoc(docConfig)

  // Held read-only until the peers found at startup have handed over their state: what is on screen
  // before that is a fragment of the document, and editing it merges into a version never seen.
  const editable = ready && synced

  // A caret means something only while its owner is still in the room and still reachable —
  // otherwise a peer that logged out leaves its last position sitting in the text. The entry is
  // kept with a null cursor rather than dropped, because that is what tells an editor holding
  // decorations to take them down; removing it would just stop anyone mentioning them again.
  const liveAwareness = useMemo(() => {
    const visible = new Map<string, AwarenessState>()

    for (const [address, state] of awareness) {
      const present = members?.get(address)?.live === true && peerStates.get(address) === PeerConnectionState.Connected

      visible.set(address, present ? state : { ...state, cursor: null })
    }

    return visible
  }, [awareness, members, peerStates])

  const syncMessage = (): string => {
    const peers = `${pendingPeers} peer${pendingPeers === 1 ? '' : 's'}`

    if (!ready) return 'Opening the document…'

    // Still pending after the wait ended: editable, but say so rather than let it look complete.
    if (synced) return `Waiting on ${peers} — their edits are not here yet`

    return `Collecting the document from ${peers} — read-only for now`
  }

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
        {!editable || pendingPeers > 0 ? (
          <div className={`session-view__sync-bar${editable ? ' session-view__sync-bar--soft' : ''}`}>
            <Loader2 size={13} className="session-view__sync-spinner" />
            {syncMessage()}
          </div>
        ) : null}
        {doc &&
          (docType === DocType.Code ? (
            <MonacoEditor yDoc={doc} disabled={!editable} awareness={liveAwareness} onCursorChange={updateCursor} />
          ) : (
            <DocEditor yDoc={doc} disabled={!editable} awareness={liveAwareness} onCursorChange={updateCursor} />
          ))}
      </div>
    )
  }

  // One chip per person, one dot per live session — the same identity may be open in several tabs.
  const memberList = useCallback((): ReactNode | null => {
    if (!members) return null

    const byIdentity = new Map<string, { username: string; sessions: string[] }>()

    for (const [addr, entry] of members) {
      if (entry.live) {
        const group = byIdentity.get(entry.identity) ?? { username: entry.username, sessions: [] }

        group.sessions.push(addr)

        if (!group.username.length) group.username = entry.username

        byIdentity.set(entry.identity, group)
      }
    }

    return Array.from(byIdentity, ([identity, group]) => {
      const anyConnected = group.sessions.some(addr => peerStates.get(addr) === PeerConnectionState.Connected)
      const chipClass = `session-view__member-chip${anyConnected ? ' session-view__member-chip--connected' : ''}`
      const color = colorForAddress(identity)

      return (
        <span key={identity} className={chipClass} title={`${group.sessions.length} session(s)`}>
          {group.sessions.map(addr => {
            const state = peerStates.get(addr) ?? PeerConnectionState.Registered
            const isConnected = state === PeerConnectionState.Connected

            return (
              <span
                key={addr}
                className={`session-view__member-dot${isConnected ? ' session-view__member-dot--connected' : ''}`}
                aria-hidden="true"
                title={`${addr} — ${state}`}
                style={{ background: color, boxShadow: `0 0 0 2px ${color}33` }}
              />
            )
          })}
          <code className="session-view__member-code" title={identity}>
            {group.username.length ? group.username : identity.slice(0, 8) + '…'}
          </code>
        </span>
      )
    })
  }, [members, peerStates])

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
          <button
            className={`session-view__btn session-view__btn--invite${inviteCopied ? ' session-view__btn--invite-copied' : ''}`}
            title={roomKey ? 'Copy the invite link — it carries the room key' : 'Copy the invite link'}
            onClick={copyInvite}
          >
            <Link size={13} />
            {inviteCopied ? 'Copied' : 'Invite'}
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
              setStampDraft(stamp)
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
                  value: stampDraft,
                  onChange: setStampDraft,
                  placeholder: 'required — a usable postage batch ID',
                  mono: true,
                  onReset: () => setStampDraft(''),
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
