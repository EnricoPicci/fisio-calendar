import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '@fisio/domain';
import { BehaviorSubject, lastValueFrom, Observable, of, Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  defineJourneys,
  instrumentSurface,
  JourneyHarness,
  type JourneyResult,
  ObservableRecorder,
  readResults,
  renderJourneysReport,
  renderTrace,
  type StreamObserver,
  surfaceMethods,
  TraceRecorder,
  uncoveredMembers,
} from '../src/index';

/** The shape of the web app's `ViewModel` base, enough for the harness and the surface check. */
abstract class Base {
  readonly #observers = new Set<StreamObserver>();

  observe(observer: StreamObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  dispose(): void {}

  protected stream<T>(name: string, source$: Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
      for (const o of this.#observers) o.subscribed(this, name);
      const inner = source$.subscribe({
        next: (value) => {
          for (const o of this.#observers) o.emitted(this, name, value);
          subscriber.next(value);
        },
      });
      return () => {
        inner.unsubscribe();
        for (const o of this.#observers) o.unsubscribed(this, name);
      };
    });
  }
}

class Counter extends Base {
  readonly #count = new BehaviorSubject(0);
  readonly count$ = this.stream('count$', this.#count);
  readonly label$ = this.stream('label$', of('counter'));

  increment(by = 1): void {
    this.#count.next(this.#count.value + by);
  }

  reset(): void {
    this.#count.next(0);
  }
}

describe('testkit journeys: ObservableRecorder (architecture §10.5)', () => {
  // Value: protects=a journey waiting for a value neither misses one that arrived before the wait nor matches an old one twice; fails_when=next() only looks at future values (a race in every journey) or restarts from the beginning; why_new=first recorder; seam=a Subject; no_claim=timing of real streams
  it('next() finds values emitted before the call, never twice, and fails when the stream ends', async () => {
    const subject = new Subject<number>();
    const recorder = new ObservableRecorder(subject);
    subject.next(1);
    subject.next(2);
    expect(await recorder.next((v) => v > 0)).toBe(1);
    expect(await recorder.next((v) => v > 0)).toBe(2);
    const waiting = recorder.next((v) => v === 3);
    subject.next(3);
    expect(await waiting).toBe(3);
    const never = recorder.next((v) => v === 9);
    subject.complete();
    await expect(never).rejects.toThrow(/completed before a matching value; seen \[1,2,3\]/);
    expect(recorder.values).toEqual([1, 2, 3]);
    expect(recorder.completed).toBe(true);
  });

  // Value: protects=a wait that can never succeed fails the journey with what was seen instead of hanging until the test timeout; fails_when=the timer is missing or leaks; why_new=first recorder; seam=a short timeout; no_claim=none
  it('next() rejects after its timeout with the values seen', async () => {
    const recorder = new ObservableRecorder(of(1, 2));
    await recorder.next();
    await recorder.next();
    await expect(recorder.next(() => true, 10)).rejects.toThrow(/completed/);
    const open = new ObservableRecorder(new Subject<number>());
    await expect(open.next(() => true, 10)).rejects.toThrow('No matching value within 10 ms');
    open.unsubscribe();
    expect(open.closed).toBe(true);
  });

  // Value: protects=a stream that errors fails a pending wait at once, naming the cause; fails_when=the error handler stops waking waiters (the wait runs into its timeout with a misleading message) or drops the cause; why_new=only completion and the timeout were exercised; seam=a Subject; no_claim=real streams' errors
  it('next() rejects as soon as the stream fails, with its error', async () => {
    const subject = new Subject<number>();
    const recorder = new ObservableRecorder(subject);
    const waiting = recorder.next(() => true, 60_000);
    subject.error(new Error('boom'));
    await expect(waiting).rejects.toThrow(/failed \(Error: boom\) before a matching value/);
  });
});

describe('testkit journeys: JourneyHarness and the trace (architecture §10.5)', () => {
  const harness = () => new JourneyHarness(new FixedClock('2027-03-01T08:00:00.000Z'));

  // Value: protects=the trace shows each journey step with what followed it, and only the journey's own subscriptions as steps; fails_when=internal subscriptions become steps, a record() of several streams splits, emissions lose their order, or redactions leak; why_new=first trace renderer; seam=a toy view-model on the ViewModel shape; no_claim=the web app's ViewModel (its own spec)
  it('records calls, subscriptions and emissions, and renders numbered steps with their effects', () => {
    const j = harness();
    const counter = j.traced(new (class extends Counter {})(), 'anna.counter');
    const [count] = j.record(counter.count$, counter.label$);
    counter.increment(j.redact('2', 'secret') === '2' ? 2 : 0);
    j.advance({ minutes: 5 });
    count.unsubscribe();

    expect(j.trace.calls()).toEqual(['anna.counter.increment']);
    expect(j.recorded(counter.count$)).toEqual([0, 2]);
    expect(renderTrace(j.trace.entries, { redactions: new Map([['x', 'y']]) })).toEqual([
      '1. subscribe anna.counter.count$, label$ → anna.counter.count$ emits 0',
      '                                         → anna.counter.label$ emits "counter"',
      '2. anna.counter.increment(2)             → anna.counter.count$ emits 2',
      '3. clock → 2027-03-01T08:05:00.000Z      → unsubscribe anna.counter.count$',
    ]);
    expect(j.trace.openSubscriptions('anna')).toEqual(new Map([['anna.counter.label$', 1]]));
    j.close();
    expect(j.trace.openSubscriptions()).toEqual(new Map());
  });

  // Value: protects=codes, passwords and tokens never reach docs/journeys.md, and setup steps render as one line that still names the emails they sent; fails_when=a redacted value or a JWT is printed, or a given's inner steps render; why_new=first renderer; seam=hand-made entries; no_claim=none
  it('redacts values and tokens, and renders a given step as one line with its emails', async () => {
    const j = harness();
    await j.given('Anna is a client', async () => {
      j.trace.add({ kind: 'request', service: 'api', method: 'POST', path: '/x', status: 201 });
      j.trace.add({ kind: 'email', to: 'anna@example.it', template: 'invitation' });
    });
    const code = j.redact('48213907', 'one-time code');
    // Shaped like a JWT (three base64url segments), not a real one.
    const jwt = 'headerhead.payloadpay.signature';
    j.trace.add({
      kind: 'call',
      target: 'anna.signIn',
      method: 'confirmCode',
      args: [code, { jwt }],
    });
    expect(renderTrace(j.trace.entries, { redactions: j.redactions })).toEqual([
      '1. given Anna is a client                               → email to anna@example.it (invitation)',
      '2. anna.signIn.confirmCode(<one-time code>, {"jwt":"<token>"})',
    ]);
    expect(j.trace.apiCalls()).toEqual(['POST /x']);
  });

  // Value: protects=a traced view-model keeps working (private fields need the real instance) and requests are named by path; fails_when=the proxy passes itself as `this` (TypeError on #fields) or the base path is not stripped; why_new=first proxy and fetch tracing; seam=a toy view-model and an echo fetch; no_claim=the real ApiClient
  it('traced() runs methods on the instance itself; tracedFetch() records method, path and status', async () => {
    const j = harness();
    const counter = j.traced(new Counter(), 'anna.counter');
    counter.increment();
    counter.reset();
    const fetch = j.tracedFetch(async () => new Response(null, { status: 204 }), 'auth', '/local');
    await fetch('http://auth.test/local/email-otp', { method: 'POST' });
    expect(j.trace.calls()).toEqual(['anna.counter.increment', 'anna.counter.reset']);
    expect(j.trace.apiCalls('auth')).toEqual(['POST /email-otp']);
  });

  // Value: protects=a failed assertion inside a pipeline journey fails it with the assertion's own message; fails_when=assert swallows the error or replaces the message; why_new=first operator; seam=of(); no_claim=none
  it('assert() passes values on and turns a failed assertion into the stream error', async () => {
    const j = harness();
    await expect(lastValueFrom(of(1).pipe(j.assert((v) => expect(v).toBe(1))))).resolves.toBe(1);
    await expect(lastValueFrom(of(2).pipe(j.assert((v) => expect(v).toBe(1))))).rejects.toThrow(
      'expected 2 to be 1',
    );
  });

  // Value: protects=docs/journeys.md lists journeys in catalogue order whatever order the workers finished in; fails_when=ids sort as strings (J10 before J2) or a sub-journey moves away from its number; why_new=first report; seam=hand-made results; no_claim=the intro text
  it('renderJourneysReport orders journeys by catalogue id', () => {
    const result = (id: string): JourneyResult => ({
      id,
      title: `${id} — x`,
      file: `${id}.journey.spec.ts`,
      passed: true,
      lines: ['1. step'],
    });
    const report = renderJourneysReport(['J10', 'J8-a', 'J2', 'J1'].map(result), 'Intro.');
    const order = [...report.matchAll(/^## (J[\w-]+)/gm)].map((m) => m[1]);
    expect(order).toEqual(['J1', 'J2', 'J8-a', 'J10']);
    expect(report).toMatch(
      /^# Journeys\n\nIntro\.\n\n## J1 — x\n\n`J1.journey.spec.ts`\n\n```text\n1\. step\n```\n/,
    );
  });

  // Value: protects=a subscription left open inside a given step still fails the journey; fails_when=hidden entries are dropped instead of only not rendered; why_new=first given; seam=none; no_claim=none
  it('TraceRecorder.hidden() still counts subscriptions for the bookkeeping', async () => {
    const trace = new TraceRecorder();
    await trace.hidden(async () =>
      trace.add({ kind: 'subscribe', target: 'a.b', stream: 'c$', byJourney: false }),
    );
    expect(trace.entries[0]?.hidden).toBe(true);
    expect(trace.openSubscriptions('a')).toEqual(new Map([['a.b.c$', 1]]));
  });
});

describe('testkit journeys: journey() and journey$() (architecture §10.5)', () => {
  const resultsDir = mkdtempSync(join(tmpdir(), 'fisio-journeys-'));
  class Finishing extends JourneyHarness {
    async finish(): Promise<void> {
      this.trace.add({ kind: 'given', text: 'finished' });
    }
  }
  const { journey, journey$ } = defineJourneys(
    () => new Finishing(new FixedClock('2027-03-01T08:00:00.000Z')),
    { resultsDir },
  );

  journey('J98 — an async journey', async (j) => {
    j.advance({ minutes: 1 });
  });
  journey$('J99 — a pipeline journey', (j) =>
    j
      .advanceTo$('2027-03-01T09:00:00.000Z')
      .pipe(j.assert(() => expect(j.clock.now().getUTCHours()).toBe(9))),
  );

  // Value: protects=every journey leaves its rendered trace for docs/journeys.md, finished and marked passed, in either style; fails_when=finish() is skipped, the result is not written, or journey$ does not wait for the pipeline; why_new=first journey runner; seam=a temporary results directory; no_claim=the web app's harness
  it('each journey wrote its rendered trace after finish(), marked passed', () => {
    const results = readResults<JourneyResult>(resultsDir, 'journeys');
    expect(
      results
        .map(({ id, passed, lines, file }) => ({ id, passed, lines, file }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      {
        id: 'J98',
        passed: true,
        file: 'journeys.spec.ts',
        lines: ['1. clock → 2027-03-01T08:01:00.000Z', '2. given finished'],
      },
      {
        id: 'J99',
        passed: true,
        file: 'journeys.spec.ts',
        lines: ['1. clock → 2027-03-01T09:00:00.000Z', '2. given finished'],
      },
    ]);
  });

  // Value: protects=docs/journeys.md can order and link every journey to the catalogue; fails_when=a journey without its J-id is accepted; why_new=first runner; seam=none; no_claim=none
  it('refuses a journey title that does not start with its catalogue id', () => {
    expect(() => journey('signs in', async () => {})).toThrow(/catalogue id/);
  });
});

describe('testkit journeys: surface coverage (architecture §10.5)', () => {
  // Value: protects=the surface is the class's own methods plus its declared streams, and only calls and subscriptions count as exercised; fails_when=base-class members are demanded per subclass, a stream subscription is not seen, or a member exercised on another class counts; why_new=first surface check; seam=toy classes on the ViewModel shape; no_claim=the web app's class list (web-surface project)
  it('logs methods called and streams subscribed per class; reports uncovered, stale and never-constructed', () => {
    class Other extends Base {
      readonly value$ = this.stream('value$', of(1));
      ping(): void {}
    }
    class Lonely extends Base {
      shout(): void {}
    }
    const surface = instrumentSurface({
      base: Base,
      bases: [Base],
      classes: [Counter, Other, Lonely],
    });
    const counter = new Counter();
    counter.increment();
    counter.count$.subscribe().unsubscribe();
    new Other().ping();

    expect(surfaceMethods(Counter, [Base])).toEqual(['increment', 'reset']);
    const log = surface.log();
    expect(log).toEqual({
      streams: { Counter: ['count$', 'label$'], Other: ['value$'] },
      exercised: { Counter: ['count$', 'increment'], Other: ['ping'] },
    });
    expect(
      uncoveredMembers({
        methods: {
          Counter: surfaceMethods(Counter, [Base]),
          Other: surfaceMethods(Other, [Base]),
          Lonely: surfaceMethods(Lonely, [Base]),
        },
        streams: log.streams,
        exercised: log.exercised,
        allowlist: ['Counter.label$', 'Other.ping'],
      }),
    ).toEqual({
      uncovered: ['Counter.reset', 'Lonely.shout', 'Other.value$'],
      stale: ['Other.ping'],
      neverConstructed: ['Lonely'],
    });
  });
});
