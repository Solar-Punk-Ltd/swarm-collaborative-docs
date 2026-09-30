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
const SIGNAL_POLL_INTERVAL_MS = 2_000
const PEER_RETRY_TIMEOUT_MS = 5_000
// Covers the peer reading our SDP off Swarm, which Bee can delay by a minute; at 45 s handshakes were lost.
const CONNECT_TIMEOUT_MS = 90_000
// An older SDP answers a peer that already gave up and re-offered.
const OFFER_MAX_AGE_MS = CONNECT_TIMEOUT_MS
// No answer can exist earlier, and reading its index too soon makes it unreadable for a minute.
const ANSWER_EARLIEST_MS = 6_000
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
  // when our offer to a peer was written — the answer cannot be readable before it
  private offerWrittenAt = new Map<string, number>()
  // offers already answered, as `peerAddress:sessionId`
  private sentAnswerKeys = new Set<string>()
  // peers with a retry timer in flight
  private pendingRetries = new Set<string>()
  // consecutive failed connection attempts per peer
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
    this.offerWrittenAt.clear()
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

  // The lower address initiates, so two peers never offer at once.
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
    this.offerWrittenAt.set(peerAddress, Date.now())

    this.logger.debug(`${TAG} offer written → ${peerAddress.slice(0, 8)}… sessionId=${sessionId.slice(0, 8)}`)
    // The only bound on the wait for an answer; a lost one would otherwise block this peer for good.
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

  // DTLS can stall in `connecting` without ever failing; tear down so a fresh offer is negotiated.
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

    // Not filtered by `live`: a stale retire would strand a peer. The retry cap stops dialling dead sessions.
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

    const offeredAt = this.offerWrittenAt.get(peerAddress)

    // The answer cannot exist yet, and reading its index early makes it unreadable once it does.
    if (offeredAt !== undefined && Date.now() - offeredAt < ANSWER_EARLIEST_MS) {
      return
    }

    const payload = await this.swarmSignal.read(peerAddress)

    // A fresh record is proof of life, so the peer earns back its retries.
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
      this.offerWrittenAt.delete(peerAddress)
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

    // Both sides send their state vector, so each sends only what the other lacks.
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

    // A closed tab never comes back; its snapshot feed still holds what it wrote.
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
  /** ICE servers for every connection. Required, no default; peers behind symmetric NAT need TURN. */
  iceServers: RTCIceServer[]
}

/** WebRTC transport signalled over Swarm feeds: no server to run, slower to connect. Throws on invalid `iceServers`. */
export function createSwarmRtcTransport(options: SwarmRtcOptions): DocTransportFactory {
  const iceServers = assertIceServers('createSwarmRtcTransport', options?.iceServers)

  return (deps: DocTransportDeps) => new SwarmRtcTransport(iceServers, deps)
}
