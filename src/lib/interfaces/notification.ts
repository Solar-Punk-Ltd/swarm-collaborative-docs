export interface NotificationPayload {
  v: number // protocol version
  topic: string
  author: string
  feedIndex: number // TODO: why not bigint ?
  delta?: string // base64-encoded Yjs delta for real-time sync; absent on join/fallback reads
}

export type NotificationHandler = (payload: NotificationPayload) => void

export interface NotificationProvider {
  subscribe(topic: string, handler: NotificationHandler): void
  publish(payload: NotificationPayload): void
  unsubscribe(): void
  addMember?(address: string): void
}
