import * as Y from 'yjs'

import { DOC_EVENTS } from '../doc/events'
import { ISwarmSignal, PeerConnectionState, SignalRecord, SignalType } from '../interfaces'
import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { Origin, uuidV4 } from '../utils/common'
import { FALLBACK_ICE_SERVER_URL } from '../utils/constants'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

import { SwarmSignal } from './swarmSignal'

const TAG = 'SwarmRtcTransport'
const SIGNAL_POLL_INTERVAL_MS = 5_000 // 5 sec
const OFFER_MAX_AGE_MS = 5 * 60 * 1_000 // 5 mins
const PEER_RETRY_TIMEOUT_MS = 5_000 // 5 sec
const CHANNEL_BINARY_TYPE = 'arraybuffer'

class SwarmRtcTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()
  private logger = Logger.getInstance()

  private swarmSignal: ISwarmSignal
  private swarmRtcPeers = new Map<string, RTCPeerConnection>()
  // sessionId per peer for correlating incoming answers to our outstanding offer
  private pendingOfferSessions = new Map<string, string>()
  // `"peerAddress:sessionId"` keys already answered — prevents double-answering the same offer
  private sentAnswerKeys = new Set<string>()
  // addresses with a retry timer in flight — prevents duplicate retries from both failed and channel-close paths
  private pendingRetries = new Set<string>()
  private signalPollTimer: ReturnType<typeof setInterval> | null = null
  private signalCheckInFlight = false
  private stopped = false
  private handler: NotificationHandler | null = null
  private openChannels = new Map<string, RTCDataChannel>()

  constructor(
    private readonly stunUrl: string,
    private readonly iceServers: RTCIceServer[] | undefined,
    private readonly deps: DocTransportDeps,
  ) {
    this.swarmSignal = new SwarmSignal(this.deps.docFeedId, this.deps.beeApiUrl, this.deps.signer, this.deps.stampId)
  }

  start(): void {
    this.swarmSignal.clearOwn()
    this.startSignalPoll()
  }

  stop(): void {
    this.stopped = true

    if (this.signalPollTimer) {
      clearInterval(this.signalPollTimer)
      this.signalPollTimer = null
    }

    for (const [, pc] of this.swarmRtcPeers) {
      pc.close()
    }

    this.swarmRtcPeers.clear()
  }

  isRemoteOrigin(origin: unknown): boolean {
    return origin === Origin.SwarmRtc
  }

  subscribe(_topic: string, handler: NotificationHandler): void {
    this.handler = handler
  }

  publish(payload: NotificationPayload): void {
    if (this.openChannels.size === 0) {
      return
    }

    const text = JSON.stringify(payload)

    for (const channel of this.openChannels.values()) {
      if (channel.readyState === 'open') {
        channel.send(text)
      }
    }
  }

  connectToPeer(address: string): void {
    if (this.swarmRtcPeers.has(address)) {
      this.logger.debug(`${TAG} connectToPeer ${address.slice(0, 8)}… skipped — already connected`)

      return
    }

    const role = this.isInitiatorFor(address) ? 'initiator' : 'answerer'
    this.logger.debug(`${TAG} connectToPeer ${address.slice(0, 8)}… role=${role}`)

    if (this.isInitiatorFor(address)) {
      this.initiateConnectionTo(address)
    }
  }

  // Lower address is always the initiator — deterministic assignment prevents both peers from sending offers simultaneously.
  private isInitiatorFor(peerAddress: string): boolean {
    return this.deps.ownAddress < peerAddress
  }

  private async initiateConnectionTo(peerAddress: string): Promise<void> {
    if (this.swarmRtcPeers.has(peerAddress)) {
      return
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length
        ? this.iceServers
        : [{ urls: this.stunUrl }, { urls: FALLBACK_ICE_SERVER_URL }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      this.logger.debug(`${TAG} [initiator→${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed') {
        pc.close()
        this.swarmRtcPeers.delete(peerAddress)
        this.pendingOfferSessions.delete(peerAddress)
        this.scheduleReconnect(peerAddress, 'ICE failed')
      } else if (pc.connectionState === 'closed') {
        this.swarmRtcPeers.delete(peerAddress)
        this.pendingOfferSessions.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      this.logger.debug(`${TAG} [initiator→${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`)
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      this.logger.warn(
        `${TAG} [initiator→${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    const dc = pc.createDataChannel('yjs')

    dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
    dc.addEventListener('error', e => this.logger.error(`${TAG} [initiator] dataChannel error`, e))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    this.logger.debug(`${TAG} ICE gathering started for ${peerAddress.slice(0, 8)}…`)

    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    this.logger.debug(
      `${TAG} ICE gathered for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`,
    )

    if (this.stopped) {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      this.logger.debug(`${TAG} initiateConnectionTo ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

      return
    }

    this.logger.debug(`${TAG} initiateConnectionTo ${peerAddress.slice(0, 8)}… instance live, writing offer`)
    const sessionId = uuidV4()
    this.pendingOfferSessions.set(peerAddress, sessionId)

    const record: SignalRecord = {
      type: SignalType.OFFER,
      fromAddress: this.deps.ownAddress,
      toAddress: peerAddress,
      sessionId,
      timestamp: Date.now(),
      sdp,
    }

    await this.swarmSignal.writeRecord(record)

    this.logger.debug(`${TAG} offer written → ${peerAddress.slice(0, 8)}… sessionId=${sessionId.slice(0, 8)}`)
  }

  private async answerPeerOffer(peerAddress: string, offer: SignalRecord): Promise<void> {
    if (this.swarmRtcPeers.has(peerAddress)) return

    const key = `${peerAddress}:${offer.sessionId}`

    if (this.sentAnswerKeys.has(key)) return

    this.logger.debug(
      `${TAG} answering offer from ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`,
    )
    this.sentAnswerKeys.add(key)

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length
        ? this.iceServers
        : [{ urls: this.stunUrl }, { urls: FALLBACK_ICE_SERVER_URL }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      this.logger.debug(`${TAG} [answerer←${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close()
        this.swarmRtcPeers.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      this.logger.debug(`${TAG} [answerer←${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`)
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      this.logger.warn(
        `${TAG} [answerer←${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      this.logger.debug(`${TAG} datachannel received from ${peerAddress.slice(0, 8)}…`)
      const dc = event.channel
      dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
      dc.addEventListener('error', e => this.logger.error(`${TAG} [answerer] dataChannel error`, e))
    })

    await pc.setRemoteDescription({ type: SignalType.OFFER, sdp: offer.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    this.logger.debug(`${TAG} ICE gathering started (answerer) for ${peerAddress.slice(0, 8)}…`)
    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    this.logger.debug(
      `${TAG} ICE gathered (answerer) for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`,
    )

    if (this.stopped) {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      this.logger.debug(`${TAG} answerPeerOffer ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

      return
    }

    if (candidateCount === 0 || pc.connectionState === 'failed') {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      this.logger.debug(`${TAG} answerPeerOffer ${peerAddress.slice(0, 8)}… aborted — ICE failed before gathering`)

      return
    }

    const record: SignalRecord = {
      type: SignalType.ANSWER,
      fromAddress: this.deps.ownAddress,
      toAddress: peerAddress,
      sessionId: offer.sessionId,
      timestamp: Date.now(),
      sdp,
    }

    await this.swarmSignal.writeRecord(record)
    this.logger.debug(`${TAG} answer written → ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`)
  }

  private startSignalPoll(): void {
    this.logger.debug(`${TAG} signal poll started (interval=${SIGNAL_POLL_INTERVAL_MS}ms)`)
    this.checkSignals()
    this.signalPollTimer = setInterval(() => this.checkSignals(), SIGNAL_POLL_INTERVAL_MS)
  }

  private async checkSignals(): Promise<void> {
    if (this.signalCheckInFlight) return

    this.signalCheckInFlight = true
    const peers = this.deps.members.all()

    if (peers.size === 0) {
      this.signalCheckInFlight = false

      return
    }

    const peerAddrs = Array.from(peers.keys())

    try {
      await Promise.allSettled(peerAddrs.map(addr => this.checkPeerSignals(addr)))
    } finally {
      this.signalCheckInFlight = false
    }
  }

  private async checkPeerSignals(peerAddress: string): Promise<void> {
    if (peerAddress === this.deps.ownAddress) {
      return
    }

    const pc = this.swarmRtcPeers.get(peerAddress)

    if (pc?.connectionState === 'connected') {
      return
    }

    const payload = await this.swarmSignal.read(peerAddress)

    if (!payload) {
      this.logger.debug(`${TAG} no new signal from ${peerAddress.slice(0, 8)}…`)

      return
    }

    this.logger.debug(`${TAG} signal feed for ${peerAddress.slice(0, 8)}… has ${payload.records.length} record(s)`)

    for (const record of payload.records) {
      const recordAgeS = Math.round((Date.now() - record.timestamp) / 1000)
      this.logger.debug(
        `${TAG}   record type=${record.type} to=${record.toAddress.slice(0, 8)} sessionId=${record.sessionId.slice(0, 8)} age=${recordAgeS}s`,
      )

      if (record.toAddress === this.deps.ownAddress) {
        if (record.type === SignalType.OFFER) await this.handleOffer(peerAddress, record)
        else if (record.type === SignalType.ANSWER) await this.handleAnswer(peerAddress, record)
      }
    }
  }

  private async handleOffer(peerAddress: string, record: SignalRecord): Promise<void> {
    const ageMs = Date.now() - record.timestamp

    if (ageMs > OFFER_MAX_AGE_MS) {
      this.logger.debug(`${TAG} skipping stale offer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`)

      return
    }

    const key = `${peerAddress}:${record.sessionId}`

    if (this.swarmRtcPeers.has(peerAddress)) {
      this.logger.debug(`${TAG} offer from ${peerAddress.slice(0, 8)}… skipped — already have PC`)

      return
    }

    if (this.sentAnswerKeys.has(key)) {
      this.logger.debug(`${TAG} offer from ${peerAddress.slice(0, 8)}… skipped — already answered`)

      return
    }

    await this.answerPeerOffer(peerAddress, record)
  }

  private async handleAnswer(peerAddress: string, record: SignalRecord): Promise<void> {
    const ageMs = Date.now() - record.timestamp

    if (ageMs > OFFER_MAX_AGE_MS) {
      this.logger.debug(
        `${TAG} skipping stale answer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`,
      )

      return
    }

    const pc = this.swarmRtcPeers.get(peerAddress)
    const expectedSession = this.pendingOfferSessions.get(peerAddress)

    this.logger.debug(
      `${TAG} answer from ${peerAddress.slice(0, 8)}… expectedSession=${expectedSession?.slice(0, 8) ?? 'none'} recordSession=${record.sessionId.slice(0, 8)} hasPC=${Boolean(pc)} alreadyAnswered=${Boolean(pc?.currentRemoteDescription)}`,
    )

    if (!pc || pc.signalingState !== 'have-local-offer' || record.sessionId !== expectedSession) return

    try {
      await pc.setRemoteDescription({ type: SignalType.ANSWER, sdp: record.sdp })
      this.pendingOfferSessions.delete(peerAddress)
      this.logger.debug(`${TAG} handshake complete with ${peerAddress.slice(0, 8)}…`)
      this.logger.debug(
        `${TAG} post-handshake state — connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState} signalingState=${pc.signalingState}`,
      )

      let polls = 0
      const poller = setInterval(() => {
        this.logger.debug(
          `${TAG} [poll ${++polls}] connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState}`,
        )

        if (polls >= 10 || pc.connectionState === 'connected' || pc.connectionState === 'failed') {
          clearInterval(poller)
        }
      }, 1000)
    } catch (err) {
      this.errorHandler.handleError(err, `${TAG}.setRemoteDescription`)
    }
  }

  private setupDataChannel(peerAddress: string, channel: RTCDataChannel): void {
    this.logger.debug(`${TAG} channel OPEN with ${peerAddress.slice(0, 8)}…`)
    this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)
    this.deps.members.setConnectionState(peerAddress, PeerConnectionState.Connected)
    this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())
    channel.binaryType = CHANNEL_BINARY_TYPE
    this.openChannels.set(peerAddress, channel)

    // send full Yjs state as binary — peer applies it directly
    const initialState = Y.encodeStateAsUpdate(this.deps.doc)
    channel.send(initialState as unknown as Uint8Array<ArrayBuffer>)

    channel.addEventListener('message', (event: MessageEvent) => {
      // binary = Yjs update, string = NotificationPayload JSON
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data)
        this.logger.debug(`${TAG} received ${data.length}B from ${peerAddress.slice(0, 8)}…`)
        Y.applyUpdate(this.deps.doc, data, Origin.SwarmRtc)
        this.deps.emitter.emit(DOC_EVENTS.DOC_UPDATED, this.deps.doc)
      } else if (typeof event.data === 'string') {
        if (!this.handler) {
          return
        }

        try {
          const payload = JSON.parse(event.data) as NotificationPayload
          this.handler(payload)
        } catch (err) {
          this.errorHandler.handleError(err, `${TAG}.onMessage`)
        }
      }
    })

    const forwardUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== Origin.SwarmRtc && origin !== Origin.Remote && channel.readyState === 'open') {
        channel.send(update as unknown as Uint8Array<ArrayBuffer>)
      }
    }

    this.deps.doc.on('update', forwardUpdate)

    channel.addEventListener('close', () => {
      this.deps.doc.off('update', forwardUpdate)
      this.openChannels.delete(peerAddress)
      const pc = this.swarmRtcPeers.get(peerAddress)
      this.swarmRtcPeers.delete(peerAddress)
      pc?.close()
      this.deps.members.setConnectionState(peerAddress, PeerConnectionState.Registered)
      this.deps.emitter.emit(DOC_EVENTS.PEER_STATE_UPDATED, this.deps.members.allConnectionStates())
      this.logger.debug(`${TAG} channel CLOSED with ${peerAddress.slice(0, 8)}…`)

      if (this.isInitiatorFor(peerAddress)) {
        this.scheduleReconnect(peerAddress, 'channel closed')
      }
    })
  }

  private scheduleReconnect(peerAddress: string, reason: string): void {
    if (this.pendingRetries.has(peerAddress)) return

    this.pendingRetries.add(peerAddress)
    this.logger.debug(
      `${TAG} [initiator→${peerAddress.slice(0, 8)}] ${reason} — retrying in ${PEER_RETRY_TIMEOUT_MS}ms`,
    )
    setTimeout(() => {
      this.pendingRetries.delete(peerAddress)

      if (!this.stopped && !this.swarmRtcPeers.has(peerAddress)) {
        this.initiateConnectionTo(peerAddress).catch(err =>
          this.errorHandler.handleError(err, `${TAG}.scheduleReconnect`),
        )
      }
    }, PEER_RETRY_TIMEOUT_MS)
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') {
        this.logger.debug(`${TAG} ICE already complete`)
        resolve()

        return
      }

      let timer: ReturnType<typeof setTimeout>

      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          this.logger.debug(`${TAG} ICE gathering complete (event)`)
          clearTimeout(timer)
          pc.removeEventListener('icegatheringstatechange', onStateChange)
          resolve()
        }
      }

      pc.addEventListener('icegatheringstatechange', onStateChange)
      timer = setTimeout(() => {
        this.logger.debug(`${TAG} ICE gathering timed out after ${timeoutMs}ms, state=${pc.iceGatheringState}`)
        pc.removeEventListener('icegatheringstatechange', onStateChange)
        resolve()
      }, timeoutMs)
    })
  }
}

/**
 * Creates a `DocTransportFactory` using Swarm-signaled WebRTC for peer-to-peer sync.
 *
 * SDP offer/answer records are written to each peer's `_signal` Swarm feed,
 * eliminating the need for a central signaling server. ICE gathering completes before
 * the SDP is written, so candidates are embedded rather than sent incrementally.
 *
 * Role assignment is deterministic: the peer with the lower Ethereum address is always
 * the initiator, preventing duplicate connections.
 *
 * `subscribe` and `publish` are no-ops — Yjs updates flow directly over WebRTC data channels.
 *
 * @param stunUrl Primary STUN server URL (e.g. `"stun:stun.l.google.com:19302"`).
 * @param iceServers Optional full ICE server list. Overrides the default STUN pair when provided.
 */
export function createSwarmRtcTransport(stunUrl: string, iceServers?: RTCIceServer[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new SwarmRtcTransport(stunUrl, iceServers, deps)
}
