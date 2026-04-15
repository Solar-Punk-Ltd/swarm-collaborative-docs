import { DocTransport, DocTransportFactory } from '../interfaces/docTransport'
import { NotificationHandler, NotificationPayload, NotificationProvider } from '../interfaces/notification'

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

class BroadcastChannelDocTransport implements DocTransport {
  private provider = new BroadcastChannelNotificationProvider()

  start(): void {}

  stop(): void {
    this.provider.unsubscribe()
  }

  subscribe(topic: string, handler: NotificationHandler): void {
    this.provider.subscribe(topic, handler)
  }

  publish(payload: NotificationPayload): void {
    this.provider.publish(payload)
  }

  // BroadcastChannel uses a shared channel — no per-peer setup needed
  connectToPeer(_address: string): void {}

  isRemoteOrigin(_origin: unknown): boolean {
    return false
  }
}

export function createBroadcastChannelTransport(): DocTransportFactory {
  return _deps => new BroadcastChannelDocTransport()
}
