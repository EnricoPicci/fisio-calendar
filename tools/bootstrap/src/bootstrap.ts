import { EmailSchema, type TenantId } from '@fisio/contracts';
import { type Clock, type IdentityProvider, type IdentityUser, isErrorNamed } from '@fisio/domain';

/**
 * `bootstrap:therapist` (docs/architecture.md §11.5, decision 8A): the only way to create the
 * therapist in any stage. Through the `IdentityProvider` port it creates the user (or finds it),
 * enables it, sets the TOTP preference to enabled and preferred, writes the tenant's Settings
 * item, and returns a one-time setup link until the therapist has chosen a password **and**
 * enrolled an authenticator: a password alone is not a finished setup. Idempotent: a re-run
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
  /**
   * The SPA's setup page, e.g. `https://dev.example.it/setup`. The link carries `email` and `code`
   * in the fragment, which browsers never send to a server, so the code stays out of access logs
   * and `Referer` headers.
   */
  readonly setupUrl: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly email: string;
  /** False on a re-run that found the user. */
  readonly created: boolean;
  /** True when the run enabled a user it found disabled. */
  readonly reenabled: boolean;
  /** Present until the therapist has chosen a password and enrolled TOTP. */
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
  const reenabled = !user.enabled;
  if (reenabled) await deps.identity.enableUser(user.userId);
  await deps.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
  await deps.settings.create(input.tenantId, deps.clock.now());
  const result = { userId: user.userId, email, created, reenabled };
  // Read again: Cognito lists TOTP as enrolled only while the preference is on (§15).
  const current = (await deps.identity.findUserByEmail(email)) ?? user;
  if (current.passwordSet && current.totpEnrolled) return result;

  const code = await deps.identity.startPasswordSetup(user.userId);
  // A password without TOTP is a setup to redo. Once the code has replaced that password, end the
  // refresh tokens it opened; access tokens already issued run out on their own (60 min).
  if (current.passwordSet) await deps.identity.globalSignOut(user.userId);
  const link = new URL(input.setupUrl);
  link.hash = new URLSearchParams({ email, code }).toString();
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
