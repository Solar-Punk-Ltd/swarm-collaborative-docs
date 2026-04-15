import { PLACEHOLDER_STAMP, validateStamps } from 'lib'
import React, { useState } from 'react'

import {
  BEE_URL_KEY,
  DEFAULT_BEE_API_URL,
  DEFAULT_ICE_SERVER_URL,
  DEFAULT_SIGNALING_SERVER_URL,
  DEFAULT_TOPIC,
  MUTABLE_STAMP_KEY,
  SIGNALING_URL_KEY,
  STUN_URL_KEY,
  TOPIC_KEY,
} from '../../utils/constants'
import { loadStunUrl } from '../../utils/localStorage'
import { Transport, TRANSPORT_LABELS, WebrtcMode } from '../../utils/types'

import './LoginView.scss'

interface LoginViewProps {
  username?: string
  beeUrl: string
  mutableStamp: string
  topic: string
  disableUntilConnected: boolean
  onBeeUrlChange: (url: string) => void
  onMutableStampChange: (v: string) => void
  onTopicChange: (v: string) => void
  onDisableUntilConnectedChange: (v: boolean) => void
  onLogin: (
    username: string,
    transport: Transport,
    topic: string,
    signalingUrl?: string,
    stunUrl?: string,
    wakuAddress?: string,
  ) => void
}

export const LoginView: React.FC<LoginViewProps> = ({
  username,
  beeUrl,
  mutableStamp,
  topic,
  disableUntilConnected,
  onBeeUrlChange,
  onMutableStampChange,
  onTopicChange,
  onDisableUntilConnectedChange,
  onLogin,
}) => {
  const [inputName, setInputName] = useState(username ?? '')
  const [transport, setTransport] = useState<Transport>(Transport.WEBRTC)
  const [serverUrl, setServerUrl] = useState(loadStunUrl() || DEFAULT_ICE_SERVER_URL)
  const [webrtcMode, setWebrtcMode] = useState<WebrtcMode>(loadStunUrl() ? WebrtcMode.SWARM : WebrtcMode.SIGNALING)
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
      await validateStamps(beeUrl, mutableStamp)
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
    <div className="login-view">
      <h2 className="login-view__title">Swarm Collab Doc</h2>
      <input
        value={inputName}
        onChange={e => setInputName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder={username ?? 'Enter username'}
        className="login-view__input"
        autoFocus
      />
      <div className="login-view__tab-bar">
        {([Transport.SWARM, Transport.BROADCAST, Transport.WEBRTC, Transport.WAKU] as const).map(t => (
          <button
            key={t}
            onClick={() => setTransport(t)}
            className={`login-view__tab-btn${transport === t ? ' login-view__tab-btn--active' : ''}`}
          >
            {TRANSPORT_LABELS[t]}
          </button>
        ))}
      </div>
      {transport === Transport.WEBRTC && (
        <div className="login-view__webrtc">
          <div className="login-view__tab-bar">
            {([WebrtcMode.SIGNALING, WebrtcMode.SWARM] as const).map(mode => (
              <button
                key={mode}
                onClick={() => {
                  setWebrtcMode(mode)
                  const itemKey = mode === WebrtcMode.SIGNALING ? SIGNALING_URL_KEY : STUN_URL_KEY
                  localStorage.setItem(itemKey, '')
                }}
                className={`login-view__tab-btn${webrtcMode === mode ? ' login-view__tab-btn--active' : ''}`}
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
              className="login-view__url-input"
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
        <div key={key} className="login-view__field">
          <label className="login-view__field-label">{label}</label>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={() => localStorage.setItem(key, value)}
            placeholder={placeholder}
            className={`login-view__field-input${mono ? ' login-view__field-input--mono' : ''}`}
          />
          {mono && (!value || value === PLACEHOLDER_STAMP) && (
            <span className="login-view__stamp-warning">⚠ No stamp set — uploads will rely on a smart gateway</span>
          )}
        </div>
      ))}
      {pageError && (
        <div className="login-view__error">
          <span className="login-view__error-text">⚠ {pageError}</span>
        </div>
      )}
      {transport !== Transport.SWARM && (
        <label className="login-view__checkbox-label">
          <input
            type="checkbox"
            checked={disableUntilConnected}
            onChange={e => onDisableUntilConnectedChange(e.target.checked)}
          />
          Disable editing until peer connected
        </label>
      )}
      <button onClick={submit} disabled={!inputName.trim() || validating} className="login-view__submit">
        {validating ? 'Checking stamps…' : 'Join'}
      </button>
    </div>
  )
}
