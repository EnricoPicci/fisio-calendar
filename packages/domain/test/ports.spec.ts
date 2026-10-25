import { describe, expect, it } from 'vitest';
import { InProcessAsyncInvoker } from '../src/ports';

describe('InProcessAsyncInvoker: the local and spec AsyncInvoker (architecture §11.4)', () => {
  // Value: protects=invoke returns before the target runs, as Lambda's Event invocation does, and settled() waits for the run; fails_when=invoke awaits the handler (hiding ordering bugs) or settled() returns early; why_new=first invoker; seam=none; no_claim=Lambda's retry behaviour
  it('starts the handler without waiting for it; settled() waits for every run, including runs it starts', async () => {
    const order: string[] = [];
    const invoker: InProcessAsyncInvoker = new InProcessAsyncInvoker({
      notifier: async (event) => {
        order.push(`run ${String(event)}`);
        if (event === 'first') await invoker.invoke('notifier', 'second');
      },
    });
    await invoker.invoke('notifier', 'first');
    order.push('caller continues');
    await invoker.settled();
    expect(order).toEqual(['caller continues', 'run first', 'run second']);

    // The handler gets a JSON copy of the event, as a Lambda payload arrives.
    const received: unknown[] = [];
    const copying = new InProcessAsyncInvoker({
      notifier: async (event) => void received.push(event),
    });
    const event = { at: new Date(0), gone: undefined };
    await copying.invoke('notifier', event);
    await copying.settled();
    expect(received).toEqual([{ at: '1970-01-01T00:00:00.000Z' }]);
    expect(received[0]).not.toBe(event);
  });

  // Value: protects=a failing async run is reported, never lost; fails_when=the catch swallows the error; why_new=first invoker; seam=none; no_claim=how the notifier records failures (WP0.6)
  it('rethrows a failed run from settled(), and refuses an unknown target', async () => {
    const invoker = new InProcessAsyncInvoker({
      notifier: async () => {
        throw new Error('boom');
      },
    });
    await invoker.invoke('notifier', {});
    await expect(invoker.settled()).rejects.toThrow('boom');
    await expect(invoker.settled()).resolves.toBeUndefined();
    await expect(new InProcessAsyncInvoker().invoke('notifier', {})).rejects.toThrow(/notifier/);
  });
});
