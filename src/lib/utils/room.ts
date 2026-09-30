import { Bytes, PrivateKey } from '@ethersphere/bee-js'

import { getSigner } from './bee'
import { remove0x, uuidV4 } from './common'

// A room is its random key: every feed topic derives from it, and it travels only in an invite's URL fragment.
const SCHEME = 'swarmdoc:v1'
const INVITE_VERSION = '1'
const DISPLAY_ID_CHARS = 32

/** Fields an invite link carries. Everything else about a room is derived from `key`. */
export interface RoomInvite {
  /** Room secret. Whoever holds it can read and write every feed in the room. */
  key: string
  /** Identity of the room's creator; member discovery starts from it. */
  creator: string
  /** Transport the room was created with, so a joiner does not have to pick one. */
  transport?: string
  /** Document kind, purely a UI hint. */
  docType?: string
}

/** Generates a random room secret. */
export function createRoomKey(): string {
  return uuidV4()
}

/** Key schedule for one room, derived entirely from its secret. */
export class Room {
  /** Room secret. Everything below is derived from it. */
  public readonly key: string
  /** Creator's identity, or `null` when there is no seed to start discovery from. */
  public readonly creator: string | null
  /** Public identifier, safe to display and log — never a credential. */
  public readonly id: string
  /** Prefix for every feed id in this room. */
  public readonly namespace: string
  /** Name a transport meets its peers under, such as a signaling-server room. */
  public readonly rendezvous: string

  private readonly secret: string

  constructor(key: string, creator?: string | null) {
    this.key = key
    this.creator = creator ? remove0x(creator.toLowerCase()) : null
    this.secret = key.trim().toLowerCase()
    this.namespace = this.digest('ns')
    this.rendezvous = this.digest('rv')
    this.id = this.digest('id').slice(0, DISPLAY_ID_CHARS)
  }

  /** Secret a transport encrypts signaling with, so a relaying server can neither read it nor join. */
  transportSecret(): string {
    return this.digest('rtc')
  }

  /** Owner address of an identity's announce feed: the identity itself, so only its key can write it. */
  announceOwner(identity: string): string {
    return remove0x(identity.toLowerCase())
  }

  /** Signing key of the directory feed, the one feed every member can append to. */
  directorySigner(): PrivateKey {
    return getSigner(`${SCHEME}:dir:${this.secret}`)
  }

  /** Owner address of the room's directory feed. */
  directoryOwner(): string {
    return this.directorySigner().publicKey().address().toString()
  }

  /** Identities discovery can start from before any feed has been read. */
  seeds(): string[] {
    return this.creator ? [this.creator] : []
  }

  private digest(purpose: string): string {
    return remove0x(Bytes.keccak256(Bytes.fromUtf8(`${SCHEME}:${purpose}:${this.secret}`)).toHex())
  }
}

/** Encodes an invite as URL fragment parameters, without `#`. Keep it a fragment: a query string reaches servers. */
export function encodeRoomInvite(invite: RoomInvite): string {
  const params = new URLSearchParams({ v: INVITE_VERSION, k: invite.key, h: remove0x(invite.creator.toLowerCase()) })

  if (invite.transport) params.set('t', invite.transport)

  if (invite.docType) params.set('d', invite.docType)

  return params.toString()
}

/** Parses invite fragment parameters, with or without `#`; `null` if they hold no usable invite. */
export function decodeRoomInvite(fragment: string): RoomInvite | null {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment)

  if (params.get('v') !== INVITE_VERSION) return null

  const key = params.get('k')
  const creator = params.get('h')

  if (!key || !creator) return null

  return {
    key,
    creator: remove0x(creator.toLowerCase()),
    transport: params.get('t') ?? undefined,
    docType: params.get('d') ?? undefined,
  }
}
