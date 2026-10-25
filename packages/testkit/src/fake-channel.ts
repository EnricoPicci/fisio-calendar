import type { NotificationChannel, OutboundMessage, SendResult } from '@fisio/domain';

/**
 * A `NotificationChannel` for specs (docs/architecture.md §10.1): records every accepted message
 * and fails on demand, so a spec asserts what was sent and drives the retry paths of the
 * delivery state machine (WP0.6).
 */
export class FakeChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly sent: OutboundMessage[] = [];
  readonly #failures: unknown[] = [];
  #nextId = 1;

  /** The next `send` calls throw these, in order, before any message is accepted. */
  failNext(...errors: unknown[]): void {
    this.#failures.push(...errors);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.#failures.length > 0) throw this.#failures.shift();
    this.sent.push(message);
    return { providerMessageId: `fake-${this.#nextId++}` };
  }

  /** The accepted messages addressed to `to`. */
  sentTo(to: string): OutboundMessage[] {
    return this.sent.filter((message) => message.to === to);
  }
}
