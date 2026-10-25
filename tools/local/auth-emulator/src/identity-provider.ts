import { randomUUID } from 'node:crypto';
import {
  type Clock,
  type IdentityProvider,
  type IdentityUser,
  IdentityUserNotFoundError,
  type NewIdentityUser,
  type TotpPreference,
} from '@fisio/domain';
import type { EmulatorConfig } from './config';
import { randomToken, sha256 } from './secrets';
import type { EmulatorStore, StoredUser } from './store';

/**
 * The `IdentityProvider` port on the emulator's user store (docs/architecture.md §11.4): what
 * `CognitoIdentityProvider` does with the Admin* calls, on DynamoDB Local. Both run
 * `IdentityProvider.contract.spec.ts`.
 */
export class LocalIdentityProvider implements IdentityProvider {
  constructor(
    private readonly store: EmulatorStore,
    private readonly clock: Clock,
    private readonly config: Pick<EmulatorConfig, 'setupCodeDays'>,
  ) {}

  async createUser(user: NewIdentityUser): Promise<IdentityUser> {
    const stored: StoredUser = {
      userId: randomUUID(),
      email: normaliseEmail(user.email),
      role: user.role,
      enabled: true,
      totpEnabled: false,
      totpPreferred: false,
      tokenGeneration: 0,
      createdAt: this.clock.now().toISOString(),
    };
    await this.store.createUser(stored);
    return toIdentityUser(stored);
  }

  async findUserByEmail(email: string): Promise<IdentityUser | undefined> {
    const user = await this.store.findUserByEmail(normaliseEmail(email));
    return user ? toIdentityUser(user) : undefined;
  }

  async disableUser(userId: string): Promise<void> {
    await this.store.updateUser(userId, { enabled: false });
  }

  async enableUser(userId: string): Promise<void> {
    await this.store.updateUser(userId, { enabled: true });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.store.deleteUser(await this.#user(userId));
  }

  async globalSignOut(userId: string): Promise<void> {
    const user = await this.#user(userId);
    await this.store.updateUser(userId, { tokenGeneration: user.tokenGeneration + 1 });
  }

  async setTotpPreference(userId: string, preference: TotpPreference): Promise<void> {
    await this.store.updateUser(userId, {
      totpEnabled: preference.enabled,
      totpPreferred: preference.enabled && preference.preferred,
    });
  }

  async startPasswordSetup(userId: string): Promise<string> {
    await this.#user(userId);
    const code = randomToken();
    const expiresAt = new Date(
      this.clock.now().getTime() + this.config.setupCodeDays * 86_400_000,
    ).toISOString();
    // One live code per user: the setup record is keyed by the code, so the user item remembers
    // the current one and an older code is refused when it is used.
    await this.store.putSetup(sha256(code), { userId, expiresAt });
    await this.store.updateUser(userId, { setupCodeHash: sha256(code) });
    return code;
  }

  async #user(userId: string): Promise<StoredUser> {
    const user = await this.store.getUser(userId);
    if (!user) throw new IdentityUserNotFoundError();
    return user;
  }
}

/** Emails are compared as `EmailSchema` stores them: trimmed and lower-cased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toIdentityUser(user: StoredUser): IdentityUser {
  return {
    userId: user.userId,
    email: user.email,
    role: user.role,
    enabled: user.enabled,
    passwordSet: user.passwordHash !== undefined,
    totp: { enabled: user.totpEnabled, preferred: user.totpPreferred },
  };
}
