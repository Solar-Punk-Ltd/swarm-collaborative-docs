const ICE_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:']

function urlsOf(server: RTCIceServer): string[] {
  return typeof server.urls === 'string' ? [server.urls] : (server.urls ?? [])
}

export function assertIceServers(factory: string, iceServers: RTCIceServer[] | undefined): RTCIceServer[] {
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    throw new Error(
      `${factory}: \`iceServers\` is required and has no default. ` +
        `Pass at least one STUN or TURN server, e.g. [{ urls: 'stun:stun.l.google.com:19302' }]. ` +
        `Peers behind symmetric NAT additionally need a TURN server with credentials.`,
    )
  }

  for (const server of iceServers) {
    const urls = urlsOf(server)

    if (urls.length === 0) {
      throw new Error(`${factory}: every entry in \`iceServers\` must have a \`urls\` value.`)
    }

    for (const url of urls) {
      if (!ICE_SCHEMES.some(scheme => url.startsWith(scheme))) {
        throw new Error(
          `${factory}: \`iceServers\` entry "${url}" is not an ICE URL. ` +
            `Expected one of ${ICE_SCHEMES.join(', ')} — a ws:// URL belongs in \`signalingUrl\`.`,
        )
      }
    }
  }

  return iceServers
}

export function assertSignalingUrl(factory: string, signalingUrl: string | undefined): string {
  if (typeof signalingUrl !== 'string' || signalingUrl.length === 0) {
    throw new Error(
      `${factory}: \`signalingUrl\` is required and has no default. ` +
        `Pass the ws:// or wss:// URL of a y-webrtc signaling server you run.`,
    )
  }

  if (!/^wss?:\/\//.test(signalingUrl)) {
    throw new Error(
      `${factory}: \`signalingUrl\` must be a ws:// or wss:// URL, got "${signalingUrl}". ` +
        `A stun:/turn: URL belongs in \`iceServers\`.`,
    )
  }

  return signalingUrl
}
