export interface NotificationPayload {
  topic: string
  author: string
  feedIndex: number
  deltaRef: string
  delta?: string // base64-encoded Yjs delta for real-time sync; absent on init/fallback reads
}

export type NotificationHandler = (payload: NotificationPayload) => void

export interface NotificationProvider {
  subscribe(topic: string, handler: NotificationHandler): void
  publish(payload: NotificationPayload): void
  unsubscribe(): void
  addMember?(address: string): void
}
