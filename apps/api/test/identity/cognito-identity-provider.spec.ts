import { IdentityUserExistsError, IdentityUserNotFoundError } from '@fisio/domain';
import { describe, expect, it } from 'vitest';
import {
  type CognitoClient,
  CognitoIdentityProvider,
} from '../../src/identity/cognito-identity-provider';

/**
 * The Cognito adapter against a recording client: the Admin* commands it sends and how it maps
 * their answers and errors. Cognito's real behaviour is the contract spec's job on `dev`
 * (`pnpm test:cloud:auth`, WP0.10).
 */
const POOL = 'eu-central-1_TestPool';
const SUB = '6a1f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f';

type Answer = (input: Record<string, unknown>) => unknown;

function recordingCognito(answers: Record<string, Answer> = {}) {
  const sent: { command: string; input: Record<string, unknown> }[] = [];
  const client: CognitoClient = {
    send: (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ command: name, input: command.input });
      const answer = answers[name];
      return answer ? answer(command.input) : {};
    }) as CognitoClient['send'],
  };
  return { client, sent, provider: new CognitoIdentityProvider(client, POOL) };
}

const cognitoError = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};

const existingUser: Record<string, Answer> = {
  AdminGetUserCommand: () => ({
    Username: SUB,
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserAttributes: [
      { Name: 'sub', Value: SUB },
      { Name: 'email', Value: 'terapista@example.test' },
    ],
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
  }),
  AdminListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'therapist' }] }),
};

describe('CognitoIdentityProvider: the IdentityProvider port on the Admin* API (§8.1)', () => {
  // Value: protects=clients are created without a password and without Cognito's own email, in their group; fails_when=MessageAction is not SUPPRESS, the email is not lower-cased or verified, or the group is skipped; why_new=first adapter; seam=recording client; no_claim=passwordless sign-in for such a user (WP0.10 spike)
  it('creates a user with MessageAction SUPPRESS, a verified email and the role as group', async () => {
    const { provider, sent } = recordingCognito(existingUser);
    const user = await provider.createUser({ email: ' Terapista@Example.test', role: 'therapist' });
    expect(sent.slice(0, 2)).toEqual([
      {
        command: 'AdminCreateUserCommand',
        input: {
          UserPoolId: POOL,
          Username: 'terapista@example.test',
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: 'terapista@example.test' },
            { Name: 'email_verified', Value: 'true' },
          ],
        },
      },
      {
        command: 'AdminAddUserToGroupCommand',
        input: { UserPoolId: POOL, Username: 'terapista@example.test', GroupName: 'therapist' },
      },
    ]);
    expect(user).toEqual({
      userId: SUB,
      email: 'terapista@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: true,
    });
  });

  // Value: protects=a half-created user never blocks bootstrap or reads as a client; fails_when=a failed group assignment leaves the user behind, or a user in no group is reported as a client; why_new=review finding (WP0.5); seam=recording client; no_claim=Cognito's real error classes (plain errors with their names here)
  it('a failed group assignment removes the user, and a user in no group is refused, not read as a client', async () => {
    const failing = recordingCognito({
      AdminAddUserToGroupCommand: cognitoError('TooManyRequestsException'),
    });
    await expect(
      failing.provider.createUser({ email: 'a@example.test', role: 'therapist' }),
    ).rejects.toMatchObject({ name: 'TooManyRequestsException' });
    expect(failing.sent.map(({ command }) => command)).toEqual([
      'AdminCreateUserCommand',
      'AdminAddUserToGroupCommand',
      'AdminDeleteUserCommand',
    ]);

    // If the removal fails too, the error names both failures instead of hiding the second.
    const stuck = recordingCognito({
      AdminAddUserToGroupCommand: cognitoError('TooManyRequestsException'),
      AdminDeleteUserCommand: cognitoError('AccessDeniedException'),
    });
    const both = await stuck.provider
      .createUser({ email: 'b@example.test', role: 'therapist' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors.map((error: Error) => error.name)).toEqual([
      'TooManyRequestsException',
      'AccessDeniedException',
    ]);

    const groupless = recordingCognito({
      ...existingUser,
      AdminListGroupsForUserCommand: () => ({ Groups: [] }),
    });
    await expect(groupless.provider.findUserByEmail('terapista@example.test')).rejects.toThrow();
  });

  // Value: protects=Cognito's error names become the port's errors; fails_when=UsernameExists/UserNotFound leak as SDK errors, another error is swallowed or remapped, or a failed create goes on to the group add; why_new=first adapter; seam=recording client; no_claim=other SDK errors' retry behaviour
  it('maps UsernameExistsException and UserNotFoundException to the port errors', async () => {
    const taken = recordingCognito({
      AdminCreateUserCommand: cognitoError('UsernameExistsException'),
    });
    await expect(
      taken.provider.createUser({ email: 'a@example.test', role: 'client' }),
    ).rejects.toThrow(IdentityUserExistsError);
    // Any other create failure passes through untouched, and nothing follows it.
    const throttled = recordingCognito({
      AdminCreateUserCommand: cognitoError('TooManyRequestsException'),
    });
    await expect(
      throttled.provider.createUser({ email: 'a@example.test', role: 'client' }),
    ).rejects.toMatchObject({ name: 'TooManyRequestsException' });
    expect(throttled.sent.map(({ command }) => command)).toEqual(['AdminCreateUserCommand']);

    const missing = recordingCognito({
      AdminGetUserCommand: cognitoError('UserNotFoundException'),
      AdminDisableUserCommand: cognitoError('UserNotFoundException'),
      AdminEnableUserCommand: cognitoError('TooManyRequestsException'),
    });
    await expect(missing.provider.findUserByEmail('a@example.test')).resolves.toBeUndefined();
    await expect(missing.provider.disableUser(SUB)).rejects.toThrow(IdentityUserNotFoundError);
    await expect(missing.provider.enableUser(SUB)).rejects.toMatchObject({
      name: 'TooManyRequestsException',
    });
  });

  // Value: protects=bootstrap and the block flow read Cognito's state right: an unconfirmed, disabled, MFA-less user is reported so; fails_when=FORCE_CHANGE_PASSWORD reads as passwordSet (bootstrap stops issuing links), Enabled false reads as enabled, or a sub-less user gets an id; why_new=only a confirmed, enabled, enrolled user is mapped; seam=recording client; no_claim=Cognito's real UserStatus values (WP0.10)
  it('reads an unconfirmed, disabled user without MFA as such, and refuses a user without a sub', async () => {
    const { provider } = recordingCognito({
      AdminGetUserCommand: () => ({
        Username: SUB,
        Enabled: false,
        UserStatus: 'FORCE_CHANGE_PASSWORD',
        UserAttributes: [
          { Name: 'sub', Value: SUB },
          { Name: 'email', Value: 'cliente@example.test' },
        ],
      }),
      AdminListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'client' }] }),
    });
    expect(await provider.findUserByEmail(' Cliente@Example.test')).toEqual({
      userId: SUB,
      email: 'cliente@example.test',
      role: 'client',
      enabled: false,
      passwordSet: false,
      totp: { enabled: false, preferred: false },
      totpEnrolled: false,
    });

    const subless = recordingCognito({
      ...existingUser,
      AdminGetUserCommand: () => ({ Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [] }),
    });
    await expect(subless.provider.findUserByEmail('a@example.test')).rejects.toThrow();
  });

  // Value: protects=each port operation sends the Admin* command §8.1 names, for the given user; fails_when=a method calls the wrong command or the wrong user; why_new=first adapter; seam=recording client; no_claim=Cognito accepting the MFA preference before TOTP enrolment (WP0.10 spike)
  it('disables, enables, deletes, signs out and sets the TOTP preference with the Admin* commands', async () => {
    const { provider, sent } = recordingCognito();
    await provider.disableUser(SUB);
    await provider.enableUser(SUB);
    await provider.deleteUser(SUB);
    await provider.globalSignOut(SUB);
    await provider.setTotpPreference(SUB, { enabled: true, preferred: true });
    // Preferred only while enabled: Cognito never gets PreferredMfa without Enabled.
    await provider.setTotpPreference(SUB, { enabled: false, preferred: true });
    expect(sent).toEqual([
      { command: 'AdminDisableUserCommand', input: { UserPoolId: POOL, Username: SUB } },
      // Disabling also ends the refresh tokens, whatever AdminDisableUser revokes on its own.
      { command: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: POOL, Username: SUB } },
      { command: 'AdminEnableUserCommand', input: { UserPoolId: POOL, Username: SUB } },
      { command: 'AdminDeleteUserCommand', input: { UserPoolId: POOL, Username: SUB } },
      { command: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: POOL, Username: SUB } },
      {
        command: 'AdminSetUserMFAPreferenceCommand',
        input: {
          UserPoolId: POOL,
          Username: SUB,
          SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
        },
      },
      {
        command: 'AdminSetUserMFAPreferenceCommand',
        input: {
          UserPoolId: POOL,
          Username: SUB,
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        },
      },
    ]);
  });

  // Value: protects=the setup code is a fresh temporary password that forces a password change; fails_when=Permanent is true, or the code is reused or too weak for the policy; why_new=first adapter; seam=recording client; no_claim=the SPA's NEW_PASSWORD_REQUIRED step (WP0.7)
  it('starts a password setup with a random temporary password (Permanent false)', async () => {
    const { provider, sent } = recordingCognito();
    const first = await provider.startPasswordSetup(SUB);
    const second = await provider.startPasswordSetup(SUB);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(12);
    expect(first).toMatch(/[a-z]/);
    expect(first).toMatch(/[A-Z]/);
    expect(first).toMatch(/\d/);
    expect(sent[0]).toEqual({
      command: 'AdminSetUserPasswordCommand',
      input: { UserPoolId: POOL, Username: SUB, Password: first, Permanent: false },
    });
  });
});
