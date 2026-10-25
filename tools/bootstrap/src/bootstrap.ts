import { EmailSchema, type TenantId } from '@fisio/contracts';
import { type Clock, type IdentityProvider, type IdentityUser, isErrorNamed } from '@fisio/domain';

/**
 * `bootstrap:therapist` (docs/architecture.md §11.5, decision 8A): the only way to create the
 * therapist in any stage. Through the `IdentityProvider` port it creates the user (or finds it),
 * enables it, sets the TOTP preference to enabled and preferred, writes the tenant's Settings
 * item, and returns a one-time setup link while no password has been chosen. Idempotent: a re-run
 * changes nothing that is already right and never creates a second user; before the setup is
 * done it issues a fresh link, which replaces the earlier one.
 */
export interface BootstrapDeps {
  readonly identity: IdentityProvider;
  /** The Settings repository (apps/api): creates the item if it is missing. */
  readonly settings: { create(tenantId: TenantId, now: Date): Promise<void> };
  readonly clock: Clock;
}

export interface BootstrapInput {
  readonly email: string;
  readonly tenantId: TenantId;
  /** The SPA's setup page, e.g. `https://dev.example.it/setup`; the link adds `email` and `code`. */
  readonly setupUrl: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly email: string;
  /** False on a re-run that found the user. */
  readonly created: boolean;
  /** Present until the therapist has chosen a password. */
  readonly setupLink?: string;
}

/** A state the CLI must not repair on its own, such as the email belonging to a client. */
export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
}

export async function bootstrapTherapist(
  deps: BootstrapDeps,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const email = EmailSchema.parse(input.email);
  const { user, created } = await findOrCreate(deps.identity, email);
  if (user.role !== 'therapist') {
    throw new BootstrapError(`${email} belongs to a client; use another address for the therapist`);
  }
  if (!user.enabled) await deps.identity.enableUser(user.userId);
  await deps.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
  await deps.settings.create(input.tenantId, deps.clock.now());
  const result = { userId: user.userId, email, created };
  if (user.passwordSet) return result;

  const link = new URL(input.setupUrl);
  link.searchParams.set('email', email);
  link.searchParams.set('code', await deps.identity.startPasswordSetup(user.userId));
  return { ...result, setupLink: link.toString() };
}

async function findOrCreate(
  identity: IdentityProvider,
  email: string,
): Promise<{ user: IdentityUser; created: boolean }> {
  const found = await identity.findUserByEmail(email);
  if (found) return { user: found, created: false };
  try {
    return { user: await identity.createUser({ email, role: 'therapist' }), created: true };
  } catch (error) {
    // A concurrent run created it between the lookup and the create.
    const raced = isErrorNamed(error, 'IdentityUserExistsError')
      ? await identity.findUserByEmail(email)
      : undefined;
    if (!raced) throw error;
    return { user: raced, created: false };
  }
}
