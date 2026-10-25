import { type Mock, vi } from 'vitest';
import type { ApiClient } from '../../src/services/api-client';

/** An `ApiClient` whose every method is a `vi.fn()` answering with `cold()` marbles. */
export type FakeApiClient = { [K in keyof ApiClient]: Mock<ApiClient[K]> };

export function fakeApi(): FakeApiClient {
  return {
    me: vi.fn(),
    addClient: vi.fn(),
  };
}
