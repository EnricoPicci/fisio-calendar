// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { useObservable } from './use-observable';

describe('useObservable: how a template reads a stream (architecture §7.1)', () => {
  it('shows a BehaviorSubject value at once and re-renders on every emission', () => {
    const source = new BehaviorSubject(1);
    const { result } = renderHook(() => useObservable(source, 0));
    expect(result.current).toBe(1);
    act(() => source.next(2));
    expect(result.current).toBe(2);
  });

  it('shows initial until a plain Subject emits', () => {
    const source = new Subject<string>();
    const { result } = renderHook(() => useObservable(source, 'initial'));
    expect(result.current).toBe('initial');
    act(() => source.next('first'));
    expect(result.current).toBe('first');
  });

  it('a stream that errors keeps the last value and logs, instead of taking the component down', () => {
    const source = new BehaviorSubject(1);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useObservable(source, 0));
    act(() => source.error(new Error('boom')));
    expect(result.current).toBe(1);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('unmount unsubscribes the source; a new source$ starts again from initial', () => {
    const a = new Subject<number>();
    const b = new Subject<number>();
    const { result, rerender, unmount } = renderHook(({ s }) => useObservable(s, -1), {
      initialProps: { s: a },
    });
    expect(a.observed).toBe(true);
    act(() => a.next(5));
    expect(result.current).toBe(5);
    rerender({ s: b });
    expect(result.current).toBe(-1);
    expect(a.observed).toBe(false);
    expect(b.observed).toBe(true);
    unmount();
    expect(b.observed).toBe(false);
  });
});
