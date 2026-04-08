import { NotificationHandler, NotificationPayload, NotificationProvider } from '../../interfaces/notification'

export class BroadcastChannelNotificationProvider implements NotificationProvider {
  private channel: BroadcastChannel | null = null

  subscribe(topic: string, handler: NotificationHandler): void {
    this.unsubscribe()
    this.channel = new BroadcastChannel(topic)
    this.channel.onmessage = (event: MessageEvent<NotificationPayload>) => {
      handler(event.data)
    }
  }

  publish(payload: NotificationPayload): void {
    if (this.channel) {
      this.channel.postMessage(payload)
    }
  }

  unsubscribe(): void {
    if (this.channel) {
      this.channel.close()
      this.channel = null
    }
  }
}
