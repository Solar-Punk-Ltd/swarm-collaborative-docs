import * as Y from 'yjs'

import { DOC_EVENTS } from '../doc/events'
import { SignalRecord, SignalType } from '../interfaces'
import { DocTransport, DocTransportDeps, DocTransportFactory } from '../interfaces/docTransport'
import type { NotificationHandler, NotificationPayload } from '../interfaces/notification'
import { uuidV4 } from '../utils/common'
import { ErrorHandler } from '../utils/error'

import { SwarmSignal } from './swarmSignal'

const TAG = 'SwarmRtcTransport'
const SIGNAL_POLL_INTERVAL_MS = 5000 // 5 sec
const OFFER_MAX_AGE_MS = 2 * 60 * 1000 // 2 mins
const CHANNEL_BINARY_TYPE = 'arraybuffer'

class SwarmRtcTransport implements DocTransport {
  private errorHandler = ErrorHandler.getInstance()

  private swarmSignal: SwarmSignal
  private swarmRtcPeers = new Map<string, RTCPeerConnection>()
  private pendingOfferSessions = new Map<string, string>()
  private sentAnswerKeys = new Set<string>()
  private signalPollTimer: ReturnType<typeof setInterval> | null = null
  private signalCheckInFlight = false
  private stopped = false

  constructor(
    private readonly stunUrl: string,
    private readonly iceServers: RTCIceServer[] | undefined,
    private readonly deps: DocTransportDeps,
  ) {
    this.swarmSignal = new SwarmSignal(
      this.deps.docFeedId,
      this.deps.beeApiUrl,
      this.deps.signer,
      this.deps.mutableStampId,
    )
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
    return origin === 'swarm-rtc'
  }

  // Swarm-signaled WebRTC uses data channels for sync — no notification channel needed
  subscribe(_topic: string, _handler: NotificationHandler): void {
    /** no-op */
  }
  publish(_payload: NotificationPayload): void {
    /** no-op */
  }

  /** Decides whether to initiate a WebRTC connection to a newly discovered peer. */
  connectToPeer(address: string): void {
    if (this.swarmRtcPeers.has(address)) {
      console.log(`${TAG} connectToPeer ${address.slice(0, 8)}… skipped — already connected`)

      return
    }

    const role = this.isInitiatorFor(address) ? 'initiator' : 'answerer'
    console.log(`${TAG} connectToPeer ${address.slice(0, 8)}… role=${role}`)

    if (this.isInitiatorFor(address)) {
      this.initiateConnectionTo(address)
    }
    // Answerers wait — startSignalPoll() will pick up the initiator's offer
  }

  /** Deterministic role: lower address is always the initiator. Prevents duplicate connections. */
  private isInitiatorFor(peerAddress: string): boolean {
    return this.deps.ownAddress < peerAddress
  }

  /** Creates an RTCPeerConnection as the initiator, gathers ICE, publishes offer to signal feed. */
  private async initiateConnectionTo(peerAddress: string): Promise<void> {
    if (this.swarmRtcPeers.has(peerAddress)) return

    console.log(`${TAG} initiating → ${peerAddress.slice(0, 8)}…`)

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length ? this.iceServers : [{ urls: this.stunUrl }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      console.log(`${TAG} [initiator→${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.swarmRtcPeers.delete(peerAddress)
        this.pendingOfferSessions.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`${TAG} [initiator→${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`)
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      console.warn(
        `${TAG} [initiator→${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    const dc = pc.createDataChannel('yjs')

    dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
    dc.addEventListener('error', e => console.error(`${TAG} [initiator] dataChannel error`, e))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    console.log(`${TAG} ICE gathering started for ${peerAddress.slice(0, 8)}…`)
    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    console.log(`${TAG} ICE gathered for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`)

    if (this.stopped) {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} initiateConnectionTo ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

      return
    }

    console.log(`${TAG} initiateConnectionTo ${peerAddress.slice(0, 8)}… instance live, writing offer`)
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
    console.log(`${TAG} offer written → ${peerAddress.slice(0, 8)}… sessionId=${sessionId.slice(0, 8)}`)
  }

  /** Receives a peer's offer, creates an answer, publishes it to own signal feed. */
  private async answerPeerOffer(peerAddress: string, offer: SignalRecord): Promise<void> {
    if (this.swarmRtcPeers.has(peerAddress)) return

    const key = `${peerAddress}:${offer.sessionId}`

    if (this.sentAnswerKeys.has(key)) return

    console.log(`${TAG} answering offer from ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`)
    this.sentAnswerKeys.add(key)

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers?.length ? this.iceServers : [{ urls: this.stunUrl }],
    })
    this.swarmRtcPeers.set(peerAddress, pc)

    pc.addEventListener('connectionstatechange', () => {
      console.log(`${TAG} [answerer←${peerAddress.slice(0, 8)}] connectionState=${pc.connectionState}`)

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.swarmRtcPeers.delete(peerAddress)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`${TAG} [answerer←${peerAddress.slice(0, 8)}] iceConnectionState=${pc.iceConnectionState}`)
    })

    pc.addEventListener('icecandidateerror', (e: RTCPeerConnectionIceErrorEvent) => {
      console.warn(
        `${TAG} [answerer←${peerAddress.slice(0, 8)}] ICE candidate error — url=${e.url} errorCode=${e.errorCode} errorText=${e.errorText}`,
      )
    })

    pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      console.log(`${TAG} datachannel received from ${peerAddress.slice(0, 8)}…`)
      const dc = event.channel
      dc.addEventListener('open', () => this.setupDataChannel(peerAddress, dc))
      dc.addEventListener('error', e => console.error(`${TAG} [answerer] dataChannel error`, e))
    })

    await pc.setRemoteDescription({ type: SignalType.OFFER, sdp: offer.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    console.log(`${TAG} ICE gathering started (answerer) for ${peerAddress.slice(0, 8)}…`)
    await this.waitForIceGatheringComplete(pc)

    const sdp = pc.localDescription?.sdp ?? ''
    const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length
    console.log(
      `${TAG} ICE gathered (answerer) for ${peerAddress.slice(0, 8)}… candidates=${candidateCount} sdpLen=${sdp.length}`,
    )

    if (this.stopped) {
      pc.close()
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} answerPeerOffer ${peerAddress.slice(0, 8)}… aborted — instance stopped`)

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
    console.log(`${TAG} answer written → ${peerAddress.slice(0, 8)}… sessionId=${offer.sessionId.slice(0, 8)}`)
  }

  /** Polls each known peer's signal feed for offers (to answer) and answers (to finalise). */
  private startSignalPoll(): void {
    console.log(`${TAG} signal poll started (interval=${SIGNAL_POLL_INTERVAL_MS}ms)`)
    this.checkSignals()
    this.signalPollTimer = setInterval(() => this.checkSignals(), SIGNAL_POLL_INTERVAL_MS)
  }

  private async checkSignals(): Promise<void> {
    if (this.signalCheckInFlight) return

    this.signalCheckInFlight = true
    const peers = this.deps.members.all()

    if (peers.length === 0) {
      this.signalCheckInFlight = false

      return
    }

    console.log(`${TAG} checking signals for ${peers.length} peer(s): ${peers.map(a => a.slice(0, 8)).join(', ')}`)

    try {
      await Promise.allSettled(peers.map(addr => this.checkPeerSignals(addr)))
    } finally {
      this.signalCheckInFlight = false
    }
  }

  private async checkPeerSignals(peerAddress: string): Promise<void> {
    if (peerAddress === this.deps.ownAddress) return

    const pc = this.swarmRtcPeers.get(peerAddress)

    if (pc?.connectionState === 'connected') return

    const payload = await this.swarmSignal.read(peerAddress)

    if (!payload) {
      console.log(`${TAG} no new signal from ${peerAddress.slice(0, 8)}…`)

      return
    }

    console.log(`${TAG} signal feed for ${peerAddress.slice(0, 8)}… has ${payload.records.length} record(s)`)

    for (const record of payload.records) {
      const recordAgeS = Math.round((Date.now() - record.timestamp) / 1000)
      console.log(
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
      console.log(`${TAG} skipping stale offer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`)

      return
    }

    const key = `${peerAddress}:${record.sessionId}`

    if (this.swarmRtcPeers.has(peerAddress)) {
      console.log(`${TAG} offer from ${peerAddress.slice(0, 8)}… skipped — already have PC`)

      return
    }

    if (this.sentAnswerKeys.has(key)) {
      console.log(`${TAG} offer from ${peerAddress.slice(0, 8)}… skipped — already answered`)

      return
    }

    await this.answerPeerOffer(peerAddress, record)
  }

  private async handleAnswer(peerAddress: string, record: SignalRecord): Promise<void> {
    const ageMs = Date.now() - record.timestamp

    if (ageMs > OFFER_MAX_AGE_MS) {
      console.log(`${TAG} skipping stale answer from ${peerAddress.slice(0, 8)}… age=${Math.round(ageMs / 1000)}s`)

      return
    }

    const pc = this.swarmRtcPeers.get(peerAddress)
    const expectedSession = this.pendingOfferSessions.get(peerAddress)

    console.log(
      `${TAG} answer from ${peerAddress.slice(0, 8)}… expectedSession=${expectedSession?.slice(0, 8) ?? 'none'} recordSession=${record.sessionId.slice(0, 8)} hasPC=${Boolean(pc)} alreadyAnswered=${Boolean(pc?.currentRemoteDescription)}`,
    )

    if (!pc || pc.signalingState !== 'have-local-offer' || record.sessionId !== expectedSession) return

    try {
      await pc.setRemoteDescription({ type: SignalType.ANSWER, sdp: record.sdp })
      this.pendingOfferSessions.delete(peerAddress)
      console.log(`${TAG} handshake complete with ${peerAddress.slice(0, 8)}…`)
      console.log(
        `${TAG} post-handshake state — connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState} signalingState=${pc.signalingState}`,
      )

      let polls = 0
      const poller = setInterval(() => {
        console.log(
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

  /** Sets up Yjs sync over an open WebRTC data channel. */
  private setupDataChannel(peerAddress: string, channel: RTCDataChannel): void {
    console.log(`${TAG} channel OPEN with ${peerAddress.slice(0, 8)}…`)
    this.deps.emitter.emit(DOC_EVENTS.PEERS_CONNECTED, true)

    // Must be set before any messages arrive; default 'blob' causes Uint8Array construction to fail.
    channel.binaryType = CHANNEL_BINARY_TYPE

    const initialState = Y.encodeStateAsUpdate(this.deps.doc)
    console.log(`${TAG} sending initial state to ${peerAddress.slice(0, 8)}… bytes=${initialState.length}`)
    channel.send(initialState as unknown as Uint8Array<ArrayBuffer>)

    channel.addEventListener('message', (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      console.log(`${TAG} received ${data.length}B from ${peerAddress.slice(0, 8)}…`)
      Y.applyUpdate(this.deps.doc, data, 'swarm-rtc')
      this.deps.emitter.emit(DOC_EVENTS.DOC_UPDATED, this.deps.doc)
    })

    const forwardUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== 'swarm-rtc' && origin !== 'remote' && channel.readyState === 'open') {
        console.log(`${TAG} forwarding update ${update.length}B → ${peerAddress.slice(0, 8)}…`)
        channel.send(update as unknown as Uint8Array<ArrayBuffer>)
      }
    }

    this.deps.doc.on('update', forwardUpdate)

    channel.addEventListener('close', () => {
      this.deps.doc.off('update', forwardUpdate)
      this.swarmRtcPeers.delete(peerAddress)
      console.log(`${TAG} channel CLOSED with ${peerAddress.slice(0, 8)}…`)
    })
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') {
        console.log(`${TAG} ICE already complete`)
        resolve()

        return
      }

      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          console.log(`${TAG} ICE gathering complete (event)`)
          resolve()
        }
      }

      pc.addEventListener('icegatheringstatechange', onStateChange)
      setTimeout(() => {
        console.log(`${TAG} ICE gathering timed out after ${timeoutMs}ms, state=${pc.iceGatheringState}`)
        resolve()
      }, timeoutMs)
    })
  }
}

export function createSwarmRtcTransport(stunUrl: string, iceServers?: RTCIceServer[]): DocTransportFactory {
  return (deps: DocTransportDeps) => new SwarmRtcTransport(stunUrl, iceServers, deps)
}
