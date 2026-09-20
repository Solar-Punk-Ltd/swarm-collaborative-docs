import * as Y from 'yjs'

import { DOC_EVENTS } from '../doc/events'
import { ISwarmSignal, PeerConnectionState, SignalRecord, SignalType } from '../interfaces'
import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/doc'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { Origin, uuidV4 } from '../utils/common'
import { ErrorHandler } from '../utils/error'
import { Logger } from '../utils/logger'

import { SwarmSignal } from './swarmSignal'
import { assertIceServers } from './validate'

const TAG = 'SwarmRtcTransport'
const SIGNAL_POLL_INTERVAL_MS = 2_000 // 2 sec — indexed feed reads are a direct chunk lookup
const PEER_RETRY_TIMEOUT_MS = 5_000 // 5 sec
/*
 * Time from writing or applying an SDP to a usable connection. It has to cover the peer reading
 * our half of the handshake off Swarm, not just ICE and DTLS.
 *
 * The bound that matters is Bee's, not WebRTC's. Polling an index before the peer writes it makes
 * retrieval give up on that address and answer instantly for a minute, so the first read of a
 * freshly written signal index can be delayed by the whole of that window. Anything under it
 * abandons handshakes that were about to succeed: at 45 s one gave up four seconds before its
 * answer became readable, and the round was replayed from scratch for nothing.
 */
const CONNECT_TIMEOUT_MS = 90_000
/*
 * An SDP older than the window its author holds that connection open for is answering a peer that
 * has already given up on it and will re-offer under a new session id.
 */
const OFFER_MAX_AGE_MS = CONNECT_TIMEOUT_MS
const MAX_CONSECUTIVE_RETRIES = 5
const CHANNEL_BINARY_TYPE = 'arraybuffer'

// Binary frames on the data channel carry a one-byte tag; string frames are JSON notifications.
const FRAME_STATE_VECTOR = 0
const FRAME_UPDATE = 1

function frame(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1)
  out[0] = tag
  out.set(body, 1)

  return out
}

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
  // consecutive failed connection attempts per peer — a session that reloaded never comes back
  private retryCounts = new Map<string, number>()
  private connectWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  private signalPollTimer: ReturnType<typeof setInterval> | null = null
  private signalCheckInFlight = false
  private stopped = false
  private handler: NotificationHandler | null = null
  private openChannels = new Map<string, RTCDataChannel>()

  constructor(
    private readonly iceServers: RTCIceServer[],
    private readonly deps: DocTransportDeps,
  ) {
    this.swarmSignal = new SwarmSignal(this.deps.docFeedId, this.deps.beeApiUrl, this.deps.signer, this.deps.stampId)
  }

  start(): void {
    // Poll only once our own feed is clean, so a peer never answers an offer we already abandoned.
    this.swarmSignal
      .clearOwn()
      .catch(err => this.errorHandler.handleError(err, `${TAG}.start`))
      .finally(() => {
        if (!this.stopped) {
          this.startSignalPoll()
        }
      })

    this.deps.emitter.emit(DOC_EVENTS.TRANSPORT_READY, true)
  }

  stop(): void {
    this.stopped = true
    // A write landing after stop would collide with the index the next instance resolves.
    this.swarmSignal.stop()

    if (this.signalPollTimer) {
      clearInterval(this.signalPollTimer)
      this.signalPollTimer = null
    }

    for (const [, pc] of this.swarmRtcPeers) {
      pc.close()
    }

    for (const timer of this.connectWatchdogs.values()) {
      clearTimeout(timer)
    }

    this.swarmRtcPeers.clear()
    this.connectWatchdogs.clear()
    this.pendingRetries.clear()
    this.retryCounts.clear()
    this.openChannels.clear()
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
      iceServers: this.iceServers,
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      this.logger.debug(`${TAG} [initiator→${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed') {
        this.clearConnectWatchdog(peerAddress)
        pc.close()
        this.swarmRtcPeers.delete(peerAddress)
        this.pendingOfferSessions.delete(peerAddress)
        this.scheduleReconnect(peerAddress, 'ICE failed')
      } else if (pc.connectionState === 'closed') {
        this.clearConnectWatchdog(peerAddress)
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
    /*
     * Nothing else bounds the wait for an answer. Without this the connection sits in
     * `swarmRtcPeers` for the rest of the session, every later attempt reports the peer as already
     * connected, and an answer that never arrives is indistinguishable from one still in flight.
     */
    this.armConnectWatchdog(peerAddress, pc)
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
      iceServers: this.iceServers,
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      this.logger.debug(`${TAG} [answerer←${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.clearConnectWatchdog(peerAddress)
        pc.close()
        this.swarmRtcPeers.delete(peerAddress)
        // The initiator drives retries; drop the answer key so its next offer is answerable.
        this.sentAnswerKeys.delete(key)
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
      this.sentAnswerKeys.delete(key)
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
    this.armConnectWatchdog(peerAddress, pc, key)
  }

  /*
   * ICE reaching `connected` does not mean the channel is usable: DTLS can stall and leave
   * `connectionState` at `connecting` indefinitely, which never fires a `failed` event and so
   * never triggers a retry. Tear the connection down so a fresh offer can be negotiated.
   */
  private armConnectWatchdog(peerAddress: string, pc: RTCPeerConnection, answerKey?: string): void {
    this.clearConnectWatchdog(peerAddress)

    const timer = setTimeout(() => {
      this.connectWatchdogs.delete(peerAddress)

      if (this.stopped || pc.connectionState === 'connected' || this.openChannels.has(peerAddress)) {
        return
      }

      this.logger.warn(
        `${TAG} ${peerAddress.slice(0, 8)}… stuck in connectionState=${pc.connectionState} after ${CONNECT_TIMEOUT_MS}ms — renegotiating`,
      )

      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      this.pendingOfferSessions.delete(peerAddress)

      if (answerKey) {
        this.sentAnswerKeys.delete(answerKey)
      }

      if (this.isInitiatorFor(peerAddress)) {
        this.scheduleReconnect(peerAddress, 'connect timeout')
      }
    }, CONNECT_TIMEOUT_MS)

    this.connectWatchdogs.set(peerAddress, timer)
  }

  private clearConnectWatchdog(peerAddress: string): void {
    const timer = this.connectWatchdogs.get(peerAddress)

    if (timer) {
      clearTimeout(timer)
      this.connectWatchdogs.delete(peerAddress)
    }
  }

  private startSignalPoll(): void {
    this.logger.debug(`${TAG} signal poll started (interval=${SIGNAL_POLL_INTERVAL_MS}ms)`)
    this.checkSignals()
    this.signalPollTimer = setInterval(() => this.checkSignals(), SIGNAL_POLL_INTERVAL_MS)
  }

  private async checkSignals(): Promise<void> {
    if (this.signalCheckInFlight) return

    this.signalCheckInFlight = true

    // Not filtered by `entry.live`: that flag is last-write-wins shared state and a stale retire
    // would permanently strand a peer. The retry cap is what stops dialling dead sessions.
    const peerAddrs = Array.from(this.deps.members.all().keys())

    if (peerAddrs.length === 0) {
      this.signalCheckInFlight = false

      return
    }

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

    // A fresh record is proof of life: let a peer that is still negotiating earn back its retries
    // rather than being written off for good by the cap.
    if (payload) {
      this.retryCounts.delete(peerAddress)
    }

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
      this.armConnectWatchdog(peerAddress, pc)
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
    this.retryCounts.delete(peerAddress)
    this.clearConnectWatchdog(peerAddress)

    // Ask for what we lack rather than pushing the whole document: both sides send their state
    // vector, so the exchange is smaller and self-healing even if one direction is lost.
    channel.send(frame(FRAME_STATE_VECTOR, Y.encodeStateVector(this.deps.doc)) as Uint8Array<ArrayBuffer>)

    channel.addEventListener('message', (event: MessageEvent) => {
      // binary = tagged Yjs frame, string = NotificationPayload JSON
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data)
        const body = data.subarray(1)
        this.logger.debug(`${TAG} received ${data.length}B tag=${data[0]} from ${peerAddress.slice(0, 8)}…`)

        if (data[0] === FRAME_STATE_VECTOR) {
          if (channel.readyState === 'open') {
            const diff = Y.encodeStateAsUpdate(this.deps.doc, body)
            channel.send(frame(FRAME_UPDATE, diff) as Uint8Array<ArrayBuffer>)
          }

          return
        }

        Y.applyUpdate(this.deps.doc, body, Origin.SwarmRtc)
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
        channel.send(frame(FRAME_UPDATE, update) as Uint8Array<ArrayBuffer>)
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

    const attempts = (this.retryCounts.get(peerAddress) ?? 0) + 1
    this.retryCounts.set(peerAddress, attempts)

    // A session that closed its tab is never reachable again; stop dialling it and rely on its
    // snapshot feed, which still holds everything it wrote.
    if (attempts > MAX_CONSECUTIVE_RETRIES) {
      this.logger.debug(`${TAG} giving up on ${peerAddress.slice(0, 8)}… after ${attempts - 1} attempts (${reason})`)

      return
    }

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

/** Configuration for {@link createSwarmRtcTransport}. */
export interface SwarmRtcOptions {
  /**
   * ICE servers used for every peer connection. Required — the library ships no default,
   * so connectivity is always a deliberate choice of the integrator.
   *
   * A STUN server suffices when at least one peer is directly reachable; peers behind
   * symmetric NAT need a TURN server with credentials.
   */
  iceServers: RTCIceServer[]
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
 * @param options Must supply `iceServers`; there is no default and no fallback.
 * @throws If `iceServers` is missing, empty, or contains a non-ICE URL.
 */
export function createSwarmRtcTransport(options: SwarmRtcOptions): DocTransportFactory {
  const iceServers = assertIceServers('createSwarmRtcTransport', options?.iceServers)

  return (deps: DocTransportDeps) => new SwarmRtcTransport(iceServers, deps)
}
