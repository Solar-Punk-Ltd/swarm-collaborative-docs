import { decodeRoomInvite, encodeRoomInvite, type RoomInvite } from 'lib'

import { DOCTYPE_KEY, ROOM_CREATOR_KEY, ROOM_KEY_KEY, TRANSPORT_KEY } from './constants'

const BEE_API_ENDPOINT_BZZ = 'bzz'

const isWindowDefined = typeof window !== 'undefined'

function appBase(): string {
  const origin = isWindowDefined ? window.location.origin : ''
  const m = isWindowDefined ? window.location.pathname.match(/^\/bzz\/([^/]+)/) : null

  return m && m[1] ? `${origin}/${BEE_API_ENDPOINT_BZZ}/${m[1]}/` : `${origin}/`
}

/**
 * Builds an invite link carrying the room secret.
 *
 * The secret goes in the fragment, which browsers never send to a server — a query parameter
 * would put it in the gateway's access log and in `Referer` on every outbound link.
 */
export const buildInviteLink = (invite: RoomInvite) => `${appBase()}#${encodeRoomInvite(invite)}`

/**
 * Reads an invite out of the current URL and stores it, then removes it from the address bar so
 * it is not carried into screenshots or copied out by accident. The stored copy is what a reload
 * rejoins from.
 *
 * Call this on load and again on `hashchange`: pasting a link that differs from the open page only
 * in its fragment sets the hash without navigating, so nothing else would notice the invite.
 *
 * @returns The invite that was consumed, or `null` if the URL held none.
 */
export const consumeInviteFromUrl = (): RoomInvite | null => {
  if (!isWindowDefined) {
    return null
  }

  const invite = decodeRoomInvite(window.location.hash)

  if (!invite) {
    return null
  }

  localStorage.setItem(ROOM_KEY_KEY, invite.key)
  localStorage.setItem(ROOM_CREATOR_KEY, invite.creator)

  if (invite.transport) localStorage.setItem(TRANSPORT_KEY, invite.transport)

  if (invite.docType) localStorage.setItem(DOCTYPE_KEY, invite.docType)

  window.history.replaceState(null, '', window.location.pathname + window.location.search)

  return invite
}
