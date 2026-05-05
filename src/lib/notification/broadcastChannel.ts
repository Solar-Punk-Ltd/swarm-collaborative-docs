import { DocTransport, DocTransportFactory } from '../interfaces/docTransport'
import { NotificationHandler, NotificationPayload, NotificationProvider } from '../interfaces/notification'

/**
 * `NotificationProvider` backed by the browser `BroadcastChannel` API.
 *
 * Delivers messages between same-origin tabs/windows sharing the same topic channel.
 * Useful for development and multi-tab testing — does not cross network boundaries.
 */
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

/**
 * Creates a `DocTransportFactory` using the browser `BroadcastChannel` API.
 *
 * Intended for same-origin multi-tab testing. Does not work across devices or origins.
 * When using y-webrtc (`createYWebrtcTransport`), this transport is redundant because
 * y-webrtc's built-in BroadcastChannel already handles cross-tab Y.js sync.
 */
export function createBroadcastChannelTransport(): DocTransportFactory {
  return _deps => new BroadcastChannelDocTransport()
}
