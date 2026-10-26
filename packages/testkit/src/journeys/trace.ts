/**
 * The timeline of a headless journey (docs/architecture.md §10.5): view-model method calls,
 * stream subscriptions and emissions, API and auth requests, emails, clock moves and ticks, in
 * the order they happened. The harness writes it; specs assert on it (`apiCalls()`,
 * `openSubscriptions()`), and {@link renderTrace} turns it into the numbered steps of
 * `docs/journeys.md`.
 *
 * `target` names a view-model as `<actor>.<view-model>` (`anna.signIn`). `byJourney` marks what
 * the journey itself did (a `j.record()`), as opposed to what a view-model or the `ApiClient`
 * subscribed to on its own; `group` ties the subscriptions of one `j.record(a$, b$)` call
 * together. `hidden` marks what happened inside a `given` step, which counts for the
 * subscription bookkeeping but is not rendered (emails excepted: a `given` names what it sent).
 */
export type TraceEvent =
  | {
      readonly kind: 'call';
      readonly target: string;
      readonly method: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly kind: 'subscribe' | 'unsubscribe';
      readonly target: string;
      readonly stream: string;
      readonly byJourney: boolean;
      readonly group?: number;
    }
  | {
      readonly kind: 'emit';
      readonly target: string;
      readonly stream: string;
      readonly value: unknown;
    }
  | {
      readonly kind: 'request';
      /** `api` for the API, `auth` for the identity provider. */
      readonly service: string;
      readonly method: string;
      readonly path: string;
      readonly status: number;
    }
  | { readonly kind: 'email'; readonly to: string; readonly template: string }
  | { readonly kind: 'clock'; readonly at: string }
  | { readonly kind: 'tick'; readonly at: string }
  | { readonly kind: 'given'; readonly text: string }
  /** An actor closes the app: `dispose` before its pages are disposed, `disposed` after. */
  | { readonly kind: 'dispose'; readonly target: string }
  | { readonly kind: 'disposed'; readonly target: string; readonly open: number };

export type TraceEntry = TraceEvent & { readonly seq: number; readonly hidden: boolean };

export class TraceRecorder {
  readonly #entries: TraceEntry[] = [];
  #hidden = 0;

  get entries(): readonly TraceEntry[] {
    return this.#entries;
  }

  add(event: TraceEvent): void {
    this.#entries.push({ ...event, seq: this.#entries.length + 1, hidden: this.#hidden > 0 });
  }

  /** Runs `body` with everything it records hidden from the rendered trace. */
  async hidden<T>(body: () => Promise<T>): Promise<T> {
    this.#hidden += 1;
    try {
      return await body();
    } finally {
      this.#hidden -= 1;
    }
  }

  /** The requests to `service` (the API by default), `METHOD /path`, in order. */
  apiCalls(service = 'api'): string[] {
    return this.#entries.flatMap((entry) =>
      entry.kind === 'request' && entry.service === service
        ? [`${entry.method} ${entry.path}`]
        : [],
    );
  }

  /** The view-model method calls, `target.method`, in order. */
  calls(): string[] {
    return this.#entries.flatMap((entry) =>
      entry.kind === 'call' ? [`${entry.target}.${entry.method}`] : [],
    );
  }

  /** Subscriptions still open, `target.stream` with their count, optionally of one actor. */
  openSubscriptions(actor?: string): Map<string, number> {
    const open = new Map<string, number>();
    for (const entry of this.#entries) {
      if (entry.kind !== 'subscribe' && entry.kind !== 'unsubscribe') continue;
      if (actor !== undefined && !entry.target.startsWith(`${actor}.`)) continue;
      const key = `${entry.target}.${entry.stream}`;
      const count = (open.get(key) ?? 0) + (entry.kind === 'subscribe' ? 1 : -1);
      if (count === 0) open.delete(key);
      else open.set(key, count);
    }
    return open;
  }
}

/** How values appear in a rendered trace: what must not or cannot be shown is replaced. */
export interface ValueFormat {
  /** Exact string values and the label shown instead (one-time codes, passwords). */
  readonly redactions: ReadonlyMap<string, string>;
}

const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*$/;
const MAX_VALUE_LENGTH = 90;
/** Step texts longer than this do not widen the column the arrows line up on. */
const MAX_STEP_WIDTH = 52;

export function formatValue(value: unknown, format: ValueFormat): string {
  const text = JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'string') return inner;
    const redacted = format.redactions.get(inner);
    if (redacted !== undefined) return `<${redacted}>`;
    return JWT.test(inner) ? '<token>' : inner;
  });
  if (text === undefined) return String(value);
  // A redaction stands alone: `"<one-time code>"` reads as `<one-time code>`.
  const bare = /^"(<[^"]*>)"$/.exec(text)?.[1] ?? text;
  return bare.length > MAX_VALUE_LENGTH ? `${bare.slice(0, MAX_VALUE_LENGTH - 1)}…` : bare;
}

interface Step {
  text: string;
  readonly effects: string[];
  readonly group?: number;
}

/**
 * The numbered steps of a trace. A step is what the journey did: a method call, a `j.record()`
 * (its streams on one line), a clock move, a tick, a `given`, an actor's dispose. The effects
 * that followed (requests, emissions, emails, the end of the journey's subscriptions) are listed
 * after its arrow, in order. Subscriptions a view-model or the `ApiClient` made on its own show
 * only through what they emitted.
 */
export function renderTrace(entries: readonly TraceEntry[], format: ValueFormat): string[] {
  const steps: Step[] = [];
  const effect = (text: string) => steps.at(-1)?.effects.push(text);
  for (const entry of entries) {
    if (entry.hidden && entry.kind !== 'email') continue;
    switch (entry.kind) {
      case 'call': {
        const args = entry.args.map((arg) => formatValue(arg, format)).join(', ');
        steps.push({ text: `${entry.target}.${entry.method}(${args})`, effects: [] });
        break;
      }
      case 'subscribe': {
        if (!entry.byJourney) break;
        const last = steps.at(-1);
        if (last && entry.group !== undefined && last.group === entry.group) {
          last.text += `, ${entry.stream}`;
        } else {
          steps.push({
            text: `subscribe ${entry.target}.${entry.stream}`,
            effects: [],
            ...(entry.group !== undefined ? { group: entry.group } : {}),
          });
        }
        break;
      }
      case 'unsubscribe':
        if (entry.byJourney) effect(`unsubscribe ${entry.target}.${entry.stream}`);
        break;
      case 'emit':
        effect(`${entry.target}.${entry.stream} emits ${formatValue(entry.value, format)}`);
        break;
      case 'request':
        effect(`${entry.service} ${entry.method} ${entry.path} ${entry.status}`);
        break;
      case 'email':
        effect(`email to ${entry.to} (${entry.template})`);
        break;
      case 'clock':
        steps.push({ text: `clock → ${entry.at}`, effects: [] });
        break;
      case 'tick':
        steps.push({ text: `tick at ${entry.at}`, effects: [] });
        break;
      case 'given':
        steps.push({ text: `given ${entry.text}`, effects: [] });
        break;
      case 'dispose':
        steps.push({ text: `${entry.target}.dispose()`, effects: [] });
        break;
      case 'disposed':
        effect(`${entry.open} open subscriptions`);
        break;
    }
  }
  const width = Math.min(Math.max(0, ...steps.map((step) => step.text.length)), MAX_STEP_WIDTH);
  const digits = String(steps.length).length;
  return steps.flatMap((step, index) => {
    const label = `${String(index + 1).padStart(digits)}. `;
    if (step.effects.length === 0) return [`${label}${step.text}`];
    const indent = ' '.repeat(label.length + width);
    // A step wider than the column puts its first effect on the next line.
    const head =
      step.text.length > width
        ? [`${label}${step.text}`, `${indent} → ${step.effects[0]}`]
        : [`${label}${step.text.padEnd(width)} → ${step.effects[0]}`];
    return [...head, ...step.effects.slice(1).map((text) => `${indent} → ${text}`)];
  });
}
