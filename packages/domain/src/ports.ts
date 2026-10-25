/**
 * Ports to the outside world that more than one package implements (docs/architecture.md §4.1,
 * principle 6); `Clock` lives in clock.ts. They sit here, free of I/O, so the API, the local
 * runtime and the testkit doubles (`FakeChannel`) share one contract and the testkit never
 * depends on `apps/api`. WP0.6 adds the notifier that uses them.
 */

/** The Lambda functions the API and the jobs handler start without waiting for them. */
export type AsyncTarget = 'notifier';

/**
 * Starts another function and returns once it is queued, not once it has run: `Lambda.invoke`
 * with `InvocationType: Event` in the cloud, an in-process call locally and in specs.
 */
export interface AsyncInvoker {
  invoke(target: AsyncTarget, event: unknown): Promise<void>;
}

export type AsyncHandler = (event: unknown) => Promise<void>;

/**
 * The local and spec form of {@link AsyncInvoker}: `invoke` starts the target's handler in the
 * same process and returns at once, as `InvocationType: Event` would; `settled()` waits for every
 * started run, so a spec can assert on what the invocation did. A failing run is collected and
 * rethrown by `settled()`, never lost. Pure dispatching, no I/O: it lives here like `FixedClock`.
 */
export class InProcessAsyncInvoker implements AsyncInvoker {
  readonly #handlers: Partial<Record<AsyncTarget, AsyncHandler>>;
  readonly #running = new Set<Promise<void>>();
  readonly #failures: unknown[] = [];

  constructor(handlers: Partial<Record<AsyncTarget, AsyncHandler>> = {}) {
    this.#handlers = { ...handlers };
  }

  async invoke(target: AsyncTarget, event: unknown): Promise<void> {
    const handler = this.#handlers[target];
    if (!handler) throw new Error(`No in-process handler for async target "${target}"`);
    // Started on a later task and never awaited here: the caller goes on first, as it does after
    // Lambda has queued the event.
    const run = new Promise<void>((resolve) => laterTask(resolve))
      .then(() => handler(event))
      .catch((error: unknown) => {
        this.#failures.push(error);
      })
      .finally(() => this.#running.delete(run));
    this.#running.add(run);
  }

  /** Waits until no started run is left (runs may start more), then rethrows the first failure. */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running);
    const [first] = this.#failures.splice(0);
    if (first !== undefined) throw first;
  }
}

/** `setTimeout(…, 0)`, which Node and browsers have but the ES library typings of this package lack. */
const laterTask = (callback: () => void): void => {
  (globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown }).setTimeout(
    callback,
    0,
  );
};

export type ChannelName = 'email';

/** One rendered message for one recipient on one channel. */
export interface OutboundMessage {
  readonly channel: ChannelName;
  /** The outbox item's deterministic key, so a duplicate send can be recognised. */
  readonly notificationKey: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface SendResult {
  /** The provider's id for the accepted message, when it returns one. */
  readonly providerMessageId?: string;
}

/**
 * Delivers one message (email in v1; WhatsApp would be another adapter behind this interface).
 * Throws `PermanentError` when retrying cannot help, anything else when it might.
 */
export interface NotificationChannel {
  readonly channel: ChannelName;
  send(message: OutboundMessage): Promise<SendResult>;
}
