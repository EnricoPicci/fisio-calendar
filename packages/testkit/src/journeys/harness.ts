import type {
  Elapsed,
  FixedClock,
  NotificationChannel,
  OutboundMessage,
  SendResult,
} from '@fisio/domain';
import { defer, map, type Observable, type OperatorFunction } from 'rxjs';
import { ObservableRecorder } from './observable-recorder';
import { TraceRecorder } from './trace';

/**
 * The application-independent half of the `JourneyHarness` (docs/architecture.md §10.5): one
 * trace, one fixed clock, the recorders, value redactions for the rendered trace, and the
 * tracing of view-models and fetches. An application's harness (`apps/web/test/journeys`)
 * extends it with its actors and its in-process stack; the testkit never imports apps.
 */

/** What a view-model offers the recorders: the `ViewModel` base of the web app, structurally. */
export interface ObservableOwner {
  observe(observer: StreamObserver): () => void;
}

export interface StreamObserver {
  subscribed(owner: object, name: string): void;
  emitted(owner: object, name: string, value: unknown): void;
  unsubscribed(owner: object, name: string): void;
}

/** One recorder per stream, in order, typed by each stream's values. */
export type Recorders<S extends readonly Observable<unknown>[]> = {
  -readonly [K in keyof S]: ObservableRecorder<S[K] extends Observable<infer T> ? T : never>;
};

/** A subscription the journey made, as the owner's observer saw it. */
interface Identity {
  readonly owner: object;
  readonly name: string;
}

export class JourneyHarness {
  readonly trace = new TraceRecorder();
  readonly clock: FixedClock;
  readonly redactions = new Map<string, string>();
  readonly #labels = new WeakMap<object, string>();
  readonly #recorders = new Map<Observable<unknown>, ObservableRecorder<unknown>>();
  readonly #journeyStreams = new Set<string>();
  readonly #detach: (() => void)[] = [];
  /** Set while the journey subscribes: the first tagged stream that reports is the journey's. */
  #subscribing: { identity?: Identity; readonly group: number } | undefined;
  #groups = 0;

  constructor(clock: FixedClock) {
    this.clock = clock;
  }

  /**
   * Subscribes the way a template would and keeps the values. Several streams at once return
   * their recorders in the same order.
   */
  record<T>(stream: Observable<T>): ObservableRecorder<T>;
  record<const S extends readonly Observable<unknown>[]>(...streams: S): Recorders<S>;
  record(
    ...streams: Observable<unknown>[]
  ): ObservableRecorder<unknown> | ObservableRecorder<unknown>[] {
    this.#groups += 1;
    const group = this.#groups;
    const recorders = streams.map((stream) => {
      const existing = this.#recorders.get(stream);
      if (existing && !existing.closed) return existing;
      const marker: { identity?: Identity; readonly group: number } = { group };
      this.#subscribing = marker;
      let recorder: ObservableRecorder<unknown>;
      try {
        recorder = new ObservableRecorder(stream);
      } finally {
        this.#subscribing = undefined;
      }
      if (marker.identity) this.#journeyStreams.add(this.#key(marker.identity));
      this.#recorders.set(stream, recorder);
      return recorder;
    });
    return streams.length === 1 ? (recorders[0] as ObservableRecorder<unknown>) : recorders;
  }

  /** The values `stream` emitted since `record(stream)`. */
  recorded<T>(stream: Observable<T>): T[] {
    const recorder = this.#recorders.get(stream as Observable<unknown>);
    if (!recorder) throw new Error('recorded(): the stream was never passed to record()');
    return recorder.values as T[];
  }

  /** Shows `label` instead of `value` wherever it appears in the rendered trace. */
  redact<T extends string>(value: T, label: string): T {
    this.redactions.set(value, label);
    return value;
  }

  advance(elapsed: Elapsed): void {
    this.clock.advance(elapsed);
    this.trace.add({ kind: 'clock', at: this.clock.now().toISOString() });
  }

  advanceTo(instant: Date | string): void {
    this.clock.set(instant);
    this.trace.add({ kind: 'clock', at: this.clock.now().toISOString() });
  }

  /** A setup step the trace names in one line; what it does inside is not rendered. */
  given<T>(text: string, body: () => Promise<T>): Promise<T> {
    this.trace.add({ kind: 'given', text });
    return this.trace.hidden(body);
  }

  /**
   * For pipeline journeys: an operator that runs `check` on each value and passes the value on.
   * A failed assertion becomes the stream's error with the assertion's own message.
   */
  assert<T>(check: (value: T) => void): OperatorFunction<T, T> {
    return map((value) => {
      check(value);
      return value;
    });
  }

  /**
   * `advanceTo` as a step of a pipeline journey. An application's harness with a scheduler
   * overrides it to run the tick after the move (§10.5).
   */
  advanceTo$(instant: Date | string): Observable<void> {
    return defer(async () => this.advanceTo(instant));
  }

  /**
   * The view-model as the journey uses it: method calls are traced under `label`, and every
   * subscription, emission and unsubscription of its streams is recorded. Methods run on the
   * view-model itself, so its private fields work.
   */
  traced<V extends ObservableOwner>(viewModel: V, label: string): V {
    this.#labels.set(viewModel, label);
    this.#detach.push(viewModel.observe(this.#observer));
    const trace = this.trace;
    return new Proxy(viewModel, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          trace.add({ kind: 'call', target: label, method: String(property), args });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  /** A `fetch` that records each request as `service METHOD path status`. */
  tracedFetch(
    fetch: typeof globalThis.fetch,
    service: string,
    basePath = '',
  ): typeof globalThis.fetch {
    return async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const response = await fetch(input, init);
      const path = new URL(request.url).pathname;
      this.trace.add({
        kind: 'request',
        service,
        method: request.method,
        path: path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path,
        status: response.status,
      });
      return response;
    };
  }

  /** Records every message `channel` accepted, named by `template(message)`. */
  tracedChannel<C extends NotificationChannel>(
    channel: C,
    template: (message: OutboundMessage) => string,
  ): C {
    const send = channel.send.bind(channel);
    channel.send = async (message: OutboundMessage): Promise<SendResult> => {
      const result = await send(message);
      this.trace.add({ kind: 'email', to: message.to, template: template(message) });
      return result;
    };
    return channel;
  }

  /** Closes every recorder and detaches from every view-model. */
  close(): void {
    for (const recorder of this.#recorders.values()) recorder.unsubscribe();
    for (const detach of this.#detach.splice(0)) detach();
  }

  readonly #observer: StreamObserver = {
    subscribed: (owner, name) => {
      const marker = this.#subscribing;
      if (marker === undefined || marker.identity !== undefined) {
        this.#add('subscribe', owner, name, false);
        return;
      }
      marker.identity = { owner, name };
      const target = this.#label(owner);
      this.trace.add({
        kind: 'subscribe',
        target,
        stream: name,
        byJourney: true,
        group: marker.group,
      });
    },
    emitted: (owner, name, value) => {
      this.trace.add({ kind: 'emit', target: this.#label(owner), stream: name, value });
    },
    unsubscribed: (owner, name) => {
      // A view-model's own subscriptions end inside the journey's; only the outer one is shown.
      const key = this.#key({ owner, name });
      const byJourney = this.#journeyStreams.has(key);
      if (byJourney) this.#journeyStreams.delete(key);
      this.#add('unsubscribe', owner, name, byJourney);
    },
  };

  #add(kind: 'subscribe' | 'unsubscribe', owner: object, name: string, byJourney: boolean): void {
    this.trace.add({ kind, target: this.#label(owner), stream: name, byJourney });
  }

  #label(owner: object): string {
    return this.#labels.get(owner) ?? owner.constructor.name;
  }

  #key(identity: Identity): string {
    return `${this.#label(identity.owner)}.${identity.name}`;
  }
}
