import { Bytes, PrivateKey } from '@ethersphere/bee-js'

import { getSigner } from './bee'
import { remove0x, uuidV4 } from './common'

/*
 * Key schedule for a room and the invite that carries it.
 *
 * A room is its key, and nothing else. The key is random, it never appears in a feed, and it
 * travels only in the fragment of an invite link, which browsers do not send to servers. Naming a
 * room instead — deriving its feed keys from a topic, as this did before — makes the name the
 * credential, so anyone who learns it can rewrite the room.
 *
 * Every feed key derives from the secret, so an invite carries nothing that can go stale. The one
 * exception is `creator`: announce feeds are addressed per identity, and a joiner holding only
 * the key would have no identity to start from until it has read the directory feed.
 */

const SCHEME = 'swarmdoc:v1'
const INVITE_VERSION = '1'
const DISPLAY_ID_CHARS = 32

/** Fields an invite link carries. Everything else about a room is derived from `key`. */
export interface RoomInvite {
  /** Room secret. Whoever holds it can read and write every feed in the room. */
  key: string
  /** identity of the room's creator — the starting point for member discovery. */
  creator: string
  /** Transport the room was created with, so a joiner does not have to pick one. */
  transport?: string
  /** Document kind, purely a UI hint. */
  docType?: string
}

/** Generates a room secret. The only source of randomness here, shared with session ids. */
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

  private readonly secret: string

  constructor(key: string, creator?: string | null) {
    this.key = key
    this.creator = creator ? remove0x(creator.toLowerCase()) : null
    this.secret = key.trim().toLowerCase()
    this.namespace = this.digest('ns')
    this.id = this.digest('id').slice(0, DISPLAY_ID_CHARS)
  }

  /**
   * Signing key for a identity's announce feed.
   *
   * One writer per identity, so an announce feed never has to merge with anyone else's write —
   * the loss of other members' entries that the shared roster feed suffered is structurally
   * impossible here.
   */
  announceSigner(identity: string): PrivateKey {
    return getSigner(`${SCHEME}:ann:${this.secret}:${remove0x(identity.toLowerCase())}`)
  }

  /** Owner address of a identity's announce feed, which is what a reader needs. */
  announceOwner(identity: string): string {
    return this.announceSigner(identity).publicKey().address().toString()
  }

  /**
   * Signing key for the room's directory feed — the one feed every member may write.
   *
   * It exists because nothing else lets a member already in the room learn that someone new has
   * arrived: announce feeds are addressed from a identity, and a identity nobody has heard of
   * has no derivable address. Entries only ever name identities and are never rewritten, so a
   * simultaneous write costs one index and a retry instead of deleting what was already there.
   */
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

/**
 * Encodes an invite as URL fragment parameters, without the leading `#`.
 *
 * The caller decides the rest of the URL. It must stay a fragment: a query string is sent to the
 * gateway serving the app, so the room key would land in its access log and in `Referer`.
 */
export function encodeRoomInvite(invite: RoomInvite): string {
  const params = new URLSearchParams({ v: INVITE_VERSION, k: invite.key, h: remove0x(invite.creator.toLowerCase()) })

  if (invite.transport) params.set('t', invite.transport)

  if (invite.docType) params.set('d', invite.docType)

  return params.toString()
}

/**
 * Parses invite fragment parameters. Accepts the fragment with or without its leading `#`.
 *
 * @returns The invite, or `null` if the fragment does not hold a usable one.
 */
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
