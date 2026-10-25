/**
 * The `IdentityProvider` port (docs/architecture.md §5.1, §8.1): the user-pool administration
 * the API and the bootstrap CLI need. `CognitoIdentityProvider` (apps/api) implements it in the
 * cloud and `LocalIdentityProvider` (tools/local/auth-emulator) on the local stack; both run the
 * same contract spec (`IdentityProvider.contract.spec.ts`). Sign-in itself is not part of it:
 * the SPA talks to Cognito, or to the emulator, directly.
 *
 * Users are addressed by `userId`, Cognito's `sub`, which is also the client id (§6.2).
 */

/** The pool groups (§8.1); the pre-token-generation trigger copies the group into `role`. */
export const IDENTITY_ROLES = ['client', 'therapist'] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];

export interface TotpPreference {
  readonly enabled: boolean;
  readonly preferred: boolean;
}

export interface IdentityUser {
  readonly userId: string;
  /** Lower-cased, as `EmailSchema` stores it. */
  readonly email: string;
  readonly role: IdentityRole;
  /** False once disabled (a blocked client): no sign-in, no token refresh. */
  readonly enabled: boolean;
  /** True once the user chose a password through the setup link (the therapist only). */
  readonly passwordSet: boolean;
  /** The MFA preference, which may be set before any authenticator is enrolled. */
  readonly totp: TotpPreference;
  /** True once an authenticator app has been enrolled and verified with a first code. */
  readonly totpEnrolled: boolean;
}

export interface NewIdentityUser {
  readonly email: string;
  readonly role: IdentityRole;
}

export interface IdentityProvider {
  /**
   * Creates the user without a password and without sending any message (Cognito:
   * `AdminCreateUser` with `MessageAction: SUPPRESS`): our own invitation goes through the
   * outbox. Throws {@link IdentityUserExistsError} when the email is taken.
   */
  createUser(user: NewIdentityUser): Promise<IdentityUser>;
  /** The user with this email, or undefined. */
  findUserByEmail(email: string): Promise<IdentityUser | undefined>;
  /**
   * Refuses sign-in and token refresh from now on, and revokes the refresh tokens issued so far
   * (Cognito's `AdminDisableUser` and `AdminUserGlobalSignOut`): enabling the user again does not
   * revive them. Idempotent.
   */
  disableUser(userId: string): Promise<void>;
  enableUser(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  /** Revokes every refresh token issued so far; access tokens run out on their own (60 min). */
  globalSignOut(userId: string): Promise<void>;
  /** The per-user TOTP MFA preference (§8.1: the therapist has it enabled and preferred). */
  setTotpPreference(userId: string, preference: TotpPreference): Promise<void>;
  /**
   * Starts a password setup and returns its one-time code, the secret part of the setup link
   * the bootstrap CLI prints (§11.5). A new code replaces any earlier one. On Cognito the code is
   * a temporary password, so a user who already had a password must choose a new one.
   */
  startPasswordSetup(userId: string): Promise<string>;
}

/** `createUser` with an email the pool already holds. */
export class IdentityUserExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super('A user with this email exists', options);
    this.name = 'IdentityUserExistsError';
  }
}

/** Any operation on a user id the pool does not hold. */
export class IdentityUserNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('No user with this id', options);
    this.name = 'IdentityUserNotFoundError';
  }
}
