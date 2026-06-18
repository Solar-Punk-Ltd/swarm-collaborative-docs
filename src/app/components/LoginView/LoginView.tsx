import { PLACEHOLDER_STAMP, uuidV4, validateStamps } from 'lib'
import { AlertCircle, AlertTriangle, FileText, LogIn } from 'lucide-react'
import React, { useCallback, useState } from 'react'

import {
  BEE_URL_KEY,
  BROKER_PEER_KEY,
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
import { loadBrokerPeer, loadDocType, loadSession, loadStunUrl, loadTransport } from '../../utils/localStorage'
import { DocType, DOCTYPE_LABELS, SessionOpts, Transport, TRANSPORT_LABELS, WebrtcMode } from '../../utils/types'
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

const Transports = [Transport.SWARM_PUBSUB, Transport.WAKU, Transport.WEBRTC] as const
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
  const [serverUrl, setServerUrl] = useState(loadStunUrl())
  const [webrtcMode, setWebrtcMode] = useState<WebrtcMode>(
    loadStunUrl() ? WebrtcMode.SWARM_SIGNAL_FEED : WebrtcMode.SIGNALING_SERVER,
  )
  const [brokerPeer, setBrokerPeer] = useState(loadBrokerPeer())
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

    if (transport === Transport.WEBRTC) {
      if (!serverUrl) {
        setPageError('Either STUN or Signaling server URL must be set!')
        setValidating(false)

        return
      }
    }

    if (transport === Transport.SWARM_PUBSUB) {
      if (!brokerPeer.trim()) {
        setPageError('Broker peer multiaddress is required for Swarm Pubsub!')
        setValidating(false)

        return
      }
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

    let signalingUrl: string | undefined = undefined
    let stunUrl: string | undefined = undefined

    if (webrtcMode === WebrtcMode.SIGNALING_SERVER) {
      signalingUrl = serverUrl
      localStorage.setItem(STUN_URL_KEY, '')
    } else {
      stunUrl = serverUrl
      localStorage.setItem(SIGNALING_URL_KEY, '')
    }

    const peer = brokerPeer.trim() || undefined

    onLogin({ username: name, transport, topic, docType, signalingUrl, stunUrl, brokerPeer: peer })
  }, [inputName, transport, topic, webrtcMode, docType, brokerPeer, beeUrl, stamp, onLogin, serverUrl])

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

              {transport === Transport.WEBRTC && (
                <div className="login-view__webrtc">
                  <div className="login-view__tab-bar">
                    {([WebrtcMode.SIGNALING_SERVER, WebrtcMode.SWARM_SIGNAL_FEED] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => {
                          setWebrtcMode(mode)
                          const itemKey = mode === WebrtcMode.SIGNALING_SERVER ? SIGNALING_URL_KEY : STUN_URL_KEY
                          const placeHolderUrl =
                            mode === WebrtcMode.SIGNALING_SERVER ? DEFAULT_SIGNALING_SERVER_URL : DEFAULT_ICE_SERVER_URL
                          setServerUrl(placeHolderUrl)
                          localStorage.setItem(itemKey, placeHolderUrl)
                        }}
                        className={`login-view__tab-btn${webrtcMode === mode ? ' login-view__tab-btn--active' : ''}`}
                      >
                        {mode === WebrtcMode.SIGNALING_SERVER ? 'Signaling Server URL' : 'Swarm Signaling STUN URL '}
                      </button>
                    ))}
                  </div>
                  <input
                    value={serverUrl}
                    onChange={e => setServerUrl(e.target.value)}
                    onBlur={() =>
                      localStorage.setItem(
                        webrtcMode === WebrtcMode.SIGNALING_SERVER ? SIGNALING_URL_KEY : STUN_URL_KEY,
                        serverUrl,
                      )
                    }
                    placeholder={
                      webrtcMode === WebrtcMode.SIGNALING_SERVER ? DEFAULT_SIGNALING_SERVER_URL : DEFAULT_ICE_SERVER_URL
                    }
                    className="login-view__url-input"
                  />
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
                  placeholder={PLACEHOLDER_STAMP}
                  className="login-view__field-input login-view__field-input--mono"
                />
                {(!stamp || stamp === PLACEHOLDER_STAMP) && (
                  <span className="login-view__stamp-warning">
                    <AlertTriangle size={12} />
                    No stamp set — uploads will rely on a gateway
                  </span>
                )}
              </div>

              {transport === Transport.SWARM_PUBSUB && (
                <div className="login-view__field">
                  <label className="login-view__field-label">Broker Peer</label>
                  <input
                    value={brokerPeer}
                    onChange={e => setBrokerPeer(e.target.value)}
                    onBlur={() => localStorage.setItem(BROKER_PEER_KEY, brokerPeer)}
                    placeholder="/ip4/1.2.3.4/tcp/1634/p2p/QmXxxx…"
                    className="login-view__url-input"
                  />
                </div>
              )}
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
