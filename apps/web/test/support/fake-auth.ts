import { type Mock, vi } from 'vitest';
import type { AuthService } from '../../src/services/auth-service';

/**
 * An `AuthService` whose every method is a `vi.fn()`: marble specs give each the `cold()` it
 * should answer with (docs/architecture.md §10.5, marble specs).
 */
export type FakeAuthService = { [K in keyof AuthService]: Mock<AuthService[K]> };

export function fakeAuth(): FakeAuthService {
  return {
    requestCode: vi.fn(),
    confirmCode: vi.fn(),
    signInWithPassword: vi.fn(),
    confirmTotp: vi.fn(),
    startSetup: vi.fn(),
    verifyTotpSetup: vi.fn(),
    restore: vi.fn(),
    refresh: vi.fn(),
    signOut: vi.fn(),
  };
}
