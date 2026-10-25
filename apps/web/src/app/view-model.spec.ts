import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type StreamObserver, streamTag, ViewModel } from './view-model';

class Sample extends ViewModel {
  readonly count = this.state(0);
  readonly count$ = this.stream('count$', this.count);
  readonly ticks = new Subject<number>();
  readonly ticks$ = this.stream('ticks$', this.ticks);

  duplicate(): void {
    this.stream('count$', new BehaviorSubject(1));
  }

  keep(teardown: () => void): void {
    this.own(teardown);
  }
}

function observer(): StreamObserver {
  return { subscribed: vi.fn(), emitted: vi.fn(), unsubscribed: vi.fn() };
}

describe('ViewModel base (architecture §7.1, view-model contract)', () => {
  it('stream() tags the observable with its owner and name, and lists it', () => {
    const vm = new Sample();
    expect(streamTag(vm.count$)).toEqual({ owner: vm, name: 'count$' });
    expect(streamTag(new Subject())).toBeUndefined();
    expect(vm.streamNames()).toEqual(['count$', 'ticks$']);
  });

  it('a stream name can be declared once', () => {
    const vm = new Sample();
    expect(() => vm.duplicate()).toThrow(/count\$/);
  });

  it('an observer records subscribe, every emission and unsubscribe of each stream', () => {
    const vm = new Sample();
    const recorder = observer();
    const detach = vm.observe(recorder);
    const subscription = vm.ticks$.subscribe();
    vm.ticks.next(1);
    vm.ticks.next(2);
    subscription.unsubscribe();
    expect(recorder.subscribed).toHaveBeenCalledWith(vm, 'ticks$');
    expect(recorder.emitted).toHaveBeenNthCalledWith(1, vm, 'ticks$', 1);
    expect(recorder.emitted).toHaveBeenNthCalledWith(2, vm, 'ticks$', 2);
    expect(recorder.unsubscribed).toHaveBeenCalledWith(vm, 'ticks$');
    detach();
    vm.ticks$.subscribe().unsubscribe();
    expect(recorder.subscribed).toHaveBeenCalledTimes(1);
  });

  it('a source error reaches the subscriber of the tagged stream', () => {
    const vm = new Sample();
    const error = vi.fn();
    vm.ticks$.subscribe({ error });
    vm.ticks.error(new Error('boom'));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('dispose() completes every stream and runs every owned teardown, once', () => {
    const vm = new Sample();
    const completed = vi.fn();
    const teardown = vi.fn();
    vm.count$.subscribe({ complete: completed });
    vm.ticks$.subscribe({ complete: completed });
    vm.keep(teardown);
    vm.dispose();
    vm.dispose();
    expect(completed).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(vm.isDisposed()).toBe(true);
    expect(vm.count.isStopped).toBe(true);
  });

  it('dispose() with a live subscription tears down the source and notifies unsubscribed', () => {
    const vm = new Sample();
    const recorder = observer();
    vm.observe(recorder);
    vm.ticks$.subscribe();
    expect(vm.ticks.observed).toBe(true);
    vm.dispose();
    expect(vm.ticks.observed).toBe(false);
    expect(recorder.unsubscribed).toHaveBeenCalledWith(vm, 'ticks$');
    expect(recorder.unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('a stream subscribed after dispose() completes at once; a teardown owned after runs at once', () => {
    const vm = new Sample();
    vm.dispose();
    const completed = vi.fn();
    const next = vi.fn();
    vm.count$.subscribe({ next, complete: completed });
    expect(next).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledTimes(1);
    const teardown = vi.fn();
    vm.keep(teardown);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
