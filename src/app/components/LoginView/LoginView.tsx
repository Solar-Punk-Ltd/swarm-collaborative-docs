import { uuidV4, validateStamps } from 'lib'
import { AlertCircle, AlertTriangle, FileText, LogIn } from 'lucide-react'
import React, { useCallback, useState } from 'react'

import {
  BEE_URL_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_SIGNALING_SERVER_URL,
  DEFAULT_TOPIC,
  DOCTYPE_KEY,
  SESSION_KEY,
  SIGNALING_URL_KEY,
  STAMP_KEY,
  STUN_URL_KEY,
  TOPIC_KEY,
  TRANSPORT_KEY,
} from '../../utils/constants'
import { loadDocType, loadSession, loadSignalingUrl, loadStunUrl, loadTransport } from '../../utils/localStorage'
import { DocType, DOCTYPE_LABELS, SessionOpts, Transport, TRANSPORT_LABELS } from '../../utils/types'
import { buildInviteLink } from '../../utils/url'

import './LoginView.scss'

const BUTTON_TIMEOUT_MS = 1500

interface LoginViewProps {
  username?: string
  beeUrl: string
  stamp: string
  topic: string
  onBeeUrlChange: (url: string) => void
  onStampChange: (v: string) => void
  onTopicChange: (v: string) => void
  onLogin: (opts: SessionOpts) => void
}

const Transports = [Transport.SWARM_RTC, Transport.SIGNALING_SERVER] as const
const DocTypes = [DocType.Code, DocType.Document] as const

export const LoginView: React.FC<LoginViewProps> = ({
  username,
  beeUrl,
  stamp,
  topic,
  onBeeUrlChange,
  onStampChange,
  onTopicChange,
  onLogin,
}) => {
  const [inputName, setInputName] = useState(username ?? '')
  const [transport, setTransport] = useState<Transport>(loadTransport())
  const [docType, setDocType] = useState<DocType>(loadDocType())
  const [stunUrl, setStunUrl] = useState(loadStunUrl())
  const [signalingUrl, setSignalingUrl] = useState(loadSignalingUrl())
  const [validating, setValidating] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [newDocIdGenerated, setNewDocIdGenerated] = useState(false)

  const handleTransportChange = (t: Transport) => {
    setTransport(t)
    localStorage.setItem(TRANSPORT_KEY, t)
  }

  const handleDocTypeChange = (d: DocType) => {
    setDocType(d)
    localStorage.setItem(DOCTYPE_KEY, d)
  }

  const handleCopyInvite = useCallback(async () => {
    try {
      const link = buildInviteLink(topic, transport, docType)
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), BUTTON_TIMEOUT_MS)
    } catch {
      // ignore
    }
  }, [topic, transport, docType])

  const handleGenerateNewDocId = useCallback(() => {
    const newDocId = uuidV4()
    onTopicChange(newDocId)
    setNewDocIdGenerated(true)

    localStorage.setItem(TOPIC_KEY, newDocId)
    const existingSession = loadSession()

    if (existingSession) {
      existingSession.topic = newDocId
      localStorage.setItem(SESSION_KEY, JSON.stringify(existingSession))
    }

    setTimeout(() => setNewDocIdGenerated(false), BUTTON_TIMEOUT_MS)
  }, [onTopicChange])

  const submit = useCallback(async () => {
    const name = inputName.trim()

    if (!name) return

    if (!stunUrl.trim()) {
      setPageError('A STUN or TURN server URL is required — both transports use WebRTC.')
      setValidating(false)

      return
    }

    if (transport === Transport.SIGNALING_SERVER && !signalingUrl.trim()) {
      setPageError('A signaling server URL is required for the signaling server transport.')
      setValidating(false)

      return
    }

    setPageError(null)
    setValidating(true)

    try {
      await validateStamps(beeUrl, stamp)
    } catch (err) {
      setPageError((err as Error).message)
      setValidating(false)

      return
    }

    setValidating(false)

    onLogin({
      username: name,
      transport,
      topic,
      docType,
      stunUrl: stunUrl.trim(),
      signalingUrl: transport === Transport.SIGNALING_SERVER ? signalingUrl.trim() : undefined,
    })
  }, [inputName, transport, topic, docType, beeUrl, stamp, onLogin, stunUrl, signalingUrl])

  return (
    <div className="login-view">
      <div className="login-view__container">
        <div className="login-view__brand">
          <div className="login-view__logo" aria-hidden="true">
            <FileText size={24} strokeWidth={2.25} />
          </div>
          <h1 className="login-view__title">Swarm Collab Doc</h1>
          <p className="login-view__subtitle">Real-time collaborative docs over Swarm</p>
        </div>

        <div className="login-view__card">
          <input
            value={inputName}
            onChange={e => setInputName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder={username ?? 'Enter username'}
            className="login-view__input"
            autoFocus
          />

          <div className="login-view__doc-id-row">
            <div style={{ flex: 1 }}>
              <label className="login-view__field-label">Document ID</label>
              <input
                value={topic}
                onChange={e => onTopicChange(e.target.value)}
                onBlur={() => localStorage.setItem(TOPIC_KEY, topic)}
                placeholder={DEFAULT_TOPIC}
                className={`login-view__field-input login-view__field-input--mono`}
              />
            </div>
          </div>

          <div style={{ marginLeft: 8 }}>
            <button
              className={`login-view__invite-btn${copied ? ' login-view__invite-btn--copied' : ''}`}
              onClick={handleCopyInvite}
              title="Copy invite link"
            >
              {copied ? 'Copied' : 'Invite'}
            </button>
            <button
              className={`login-view__new-id-btn${newDocIdGenerated ? ' login-view__new-id-btn--clicked' : ''}`}
              onClick={handleGenerateNewDocId}
              title="Generate new ID"
            >
              {'Generate new ID'}
            </button>
          </div>

          <div className="login-view__tab-bar">
            {DocTypes.map(d => (
              <button
                key={d}
                onClick={() => handleDocTypeChange(d)}
                className={`login-view__tab-btn${docType === d ? ' login-view__tab-btn--active' : ''}`}
              >
                {DOCTYPE_LABELS[d]}
              </button>
            ))}
          </div>

          <div className="login-view__advanced-toggle">
            <button onClick={() => setAdvancedOpen(o => !o)} className="login-view__advanced-toggle-btn" type="button">
              {advancedOpen ? 'Hide Advanced Settings' : 'Advanced Settings'}
            </button>
          </div>

          {advancedOpen && (
            <div className="login-view__advanced">
              <div className="login-view__tab-bar">
                {Transports.map(t => (
                  <button
                    key={t}
                    onClick={() => handleTransportChange(t)}
                    className={`login-view__tab-btn${transport === t ? ' login-view__tab-btn--active' : ''}`}
                  >
                    {TRANSPORT_LABELS[t]}
                  </button>
                ))}
              </div>

              <div className="login-view__field">
                <label className="login-view__field-label">STUN / TURN server</label>
                <input
                  value={stunUrl}
                  onChange={e => setStunUrl(e.target.value)}
                  onBlur={() => localStorage.setItem(STUN_URL_KEY, stunUrl)}
                  placeholder={DEFAULT_ICE_SERVER_URL}
                  className="login-view__url-input"
                />
              </div>

              {transport === Transport.SIGNALING_SERVER && (
                <div className="login-view__field">
                  <label className="login-view__field-label">Signaling server</label>
                  <input
                    value={signalingUrl}
                    onChange={e => setSignalingUrl(e.target.value)}
                    onBlur={() => localStorage.setItem(SIGNALING_URL_KEY, signalingUrl)}
                    placeholder={DEFAULT_SIGNALING_SERVER_URL}
                    className="login-view__url-input"
                  />
                  <span className="login-view__stamp-warning">
                    <AlertTriangle size={12} />
                    You must run this server yourself — y-webrtc provides no public one
                  </span>
                </div>
              )}

              <div className="login-view__field">
                <label className="login-view__field-label">Bee API URL</label>
                <input
                  value={beeUrl}
                  onChange={e => onBeeUrlChange(e.target.value)}
                  onBlur={() => localStorage.setItem(BEE_URL_KEY, beeUrl)}
                  placeholder={DEFAULT_BEE_API_URL}
                  className="login-view__field-input"
                />
                {beeUrl === DEFAULT_BEE_API_URL && (
                  <span className="login-view__stamp-warning">
                    <AlertTriangle size={12} />
                    Default Gateway is used
                  </span>
                )}
              </div>

              <div className="login-view__field">
                <label className="login-view__field-label">Postage stamp</label>
                <input
                  value={stamp}
                  onChange={e => onStampChange(e.target.value)}
                  onBlur={() => localStorage.setItem(STAMP_KEY, stamp)}
                  placeholder="required — a usable postage batch ID"
                  className="login-view__field-input login-view__field-input--mono"
                />
                {!stamp && (
                  <span className="login-view__stamp-warning">
                    <AlertTriangle size={12} />
                    Required — every participant writes their own feed
                  </span>
                )}
              </div>
            </div>
          )}

          {pageError && (
            <div className="login-view__error">
              <AlertCircle size={14} />
              <span className="login-view__error-text">{pageError}</span>
            </div>
          )}

          <button onClick={submit} disabled={!inputName.trim() || validating} className="login-view__submit">
            {validating ? (
              'Checking stamps…'
            ) : (
              <>
                <LogIn size={16} />
                Join
              </>
            )}
          </button>
        </div>

        <p className="login-view__footer">Powered by Ethereum Swarm</p>
      </div>
    </div>
  )
}
