import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
  AdminListGroupsForUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  IDENTITY_ROLES,
  type IdentityProvider,
  type IdentityUser,
  IdentityUserExistsError,
  IdentityUserNotFoundError,
  isErrorNamed,
  type NewIdentityUser,
  type TotpPreference,
} from '@fisio/domain';

/**
 * The `IdentityProvider` port on a Cognito user pool (docs/architecture.md §8.1): the Admin*
 * API, with the pool's email as the username attribute, so a user is addressed by email or by
 * `sub` (the user id). Users are created with `MessageAction: SUPPRESS` and no password; the
 * invitation goes through our outbox. Unit-tested against a recording client; the shared contract
 * spec runs it on the `dev` pool (`pnpm test:cloud:auth`, WP0.10).
 */
export type CognitoClient = Pick<CognitoIdentityProviderClient, 'send'>;

const MFA = 'SOFTWARE_TOKEN_MFA';

export class CognitoIdentityProvider implements IdentityProvider {
  constructor(
    private readonly cognito: CognitoClient,
    private readonly userPoolId: string,
  ) {}

  async createUser(user: NewIdentityUser): Promise<IdentityUser> {
    const email = user.email.trim().toLowerCase();
    try {
      await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
    } catch (error) {
      if (isErrorNamed(error, 'UsernameExistsException')) {
        throw new IdentityUserExistsError({ cause: error });
      }
      throw error;
    }
    try {
      await this.cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          GroupName: user.role,
        }),
      );
    } catch (error) {
      // A user without its group has no role: remove it, so a retry starts clean.
      await this.cognito
        .send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: email }))
        .catch(() => undefined);
      throw error;
    }
    const created = await this.findUserByEmail(email);
    if (!created) throw new Error('Cognito did not return the user it just created');
    return created;
  }

  async findUserByEmail(email: string): Promise<IdentityUser | undefined> {
    const username = email.trim().toLowerCase();
    let user: AdminGetUserCommandOutput;
    try {
      user = await this.cognito.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
    } catch (error) {
      if (isErrorNamed(error, 'UserNotFoundException')) return undefined;
      throw error;
    }
    const groups = await this.cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
    const attribute = (name: string) =>
      user.UserAttributes?.find((entry) => entry.Name === name)?.Value;
    const userId = attribute('sub');
    if (!userId) throw new Error('Cognito user without a sub attribute');
    const totpEnabled = (user.UserMFASettingList ?? []).includes(MFA);
    const groupNames = (groups.Groups ?? []).map((group) => group.GroupName);
    const role = IDENTITY_ROLES.find((name) => groupNames.includes(name));
    if (!role) throw new Error(`Cognito user ${userId} is in no role group`);
    return {
      userId,
      email: attribute('email') ?? username,
      role,
      enabled: user.Enabled === true,
      // FORCE_CHANGE_PASSWORD until the setup link is used; meaningful for the therapist only.
      passwordSet: user.UserStatus === 'CONFIRMED',
      totp: { enabled: totpEnabled, preferred: user.PreferredMfaSetting === MFA },
      // Cognito lists TOTP only once a token is associated and verified (§15: the WP0.10 spike
      // checks that a preference set before enrolment does not list it).
      totpEnrolled: totpEnabled,
    };
  }

  async disableUser(userId: string): Promise<void> {
    await this.#admin(() =>
      this.cognito.send(
        new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: userId }),
      ),
    );
  }

  async enableUser(userId: string): Promise<void> {
    await this.#admin(() =>
      this.cognito.send(
        new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: userId }),
      ),
    );
  }

  async deleteUser(userId: string): Promise<void> {
    await this.#admin(() =>
      this.cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: userId }),
      ),
    );
  }

  async globalSignOut(userId: string): Promise<void> {
    await this.#admin(() =>
      this.cognito.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: userId }),
      ),
    );
  }

  async setTotpPreference(userId: string, preference: TotpPreference): Promise<void> {
    await this.#admin(() =>
      this.cognito.send(
        new AdminSetUserMFAPreferenceCommand({
          UserPoolId: this.userPoolId,
          Username: userId,
          SoftwareTokenMfaSettings: {
            Enabled: preference.enabled,
            PreferredMfa: preference.enabled && preference.preferred,
          },
        }),
      ),
    );
  }

  /**
   * A random temporary password (`Permanent: false`): the setup link carries it, and the first
   * sign-in with it must choose a new password (`NEW_PASSWORD_REQUIRED`) and enrol TOTP.
   */
  async startPasswordSetup(userId: string): Promise<string> {
    const code = temporaryPassword();
    await this.#admin(() =>
      this.cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: this.userPoolId,
          Username: userId,
          Password: code,
          Permanent: false,
        }),
      ),
    );
    return code;
  }

  /** Sends an Admin* command whose only expected failure is an unknown user. */
  async #admin(send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      if (isErrorNamed(error, 'UserNotFoundException')) {
        throw new IdentityUserNotFoundError({ cause: error });
      }
      throw error;
    }
  }
}

/** 24 random characters plus one of each class the pool's password policy requires. */
function temporaryPassword(): string {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}
