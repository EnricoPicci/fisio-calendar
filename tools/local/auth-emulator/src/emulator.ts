import { type AuthErrorCode, MIN_PASSWORD_LENGTH } from '@fisio/contracts';
import type { Clock, NotificationChannel } from '@fisio/domain';
import { generateSecret, generateURI, verify } from 'otplib';
import { type EmulatorConfig, MS_PER_DAY } from './config';
import { normaliseEmail } from './identity-provider';
import type { RsaSigner } from './jwt';
import {
  hashPassword,
  numericCode,
  passwordMatches,
  randomToken,
  sameSecret,
  sha256,
} from './secrets';
import type { EmulatorStore, Session, StoredUser } from './store';

/**
 * The emulator's sign-in API (docs/architecture.md §8.1, §11.4): the flows the SPA runs against
 * Cognito, on the emulator's store, with Cognito-shaped RS256 tokens.
 *
 * - Clients: email one-time code (`USER_AUTH` / `EMAIL_OTP`). Unknown, disabled and therapist
 *   emails get the same answer as a client's, but no code is sent (C1, no account enumeration).
 * - Therapist: password, then the `SOFTWARE_TOKEN_MFA` challenge whenever the TOTP preference is
 *   enabled (T1). The bootstrap CLI's setup code sets the password and enrols TOTP once.
 * - Five wrong codes or passwords for one email lock it for 15 minutes; refresh tokens rotate,
 *   keep the first sign-in's expiry, and stop after a global sign-out or a disable.
 * - Every session, setup code and TOTP code is good once, also under concurrent answers.
 */
export interface AuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  /** Access token lifetime in seconds. */
  readonly expiresIn: number;
}

export type Challenge = 'EMAIL_OTP' | 'SOFTWARE_TOKEN_MFA';

export type SignInStep =
  | { readonly kind: 'challenge'; readonly challenge: Challenge; readonly session: string }
  | { readonly kind: 'signedIn'; readonly tokens: AuthTokens };

export interface TotpEnrolment {
  readonly session: string;
  /** Base32, for authenticator apps that take the key by hand. */
  readonly secret: string;
  readonly otpauthUri: string;
}

/** A refused sign-in step; `code` is what the SPA maps to a message. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(`Sign-in refused: ${code}`);
    this.name = 'AuthError';
  }
}

/** The issuer name authenticator apps show next to the code. */
const TOTP_ISSUER = 'Fisio Calendar';
/** One 30-second step either side, for a phone clock slightly off. */
const TOTP_TOLERANCE_SECONDS = 30;
const TOTP_CODE = /^\d{6}$/;

export interface AuthEmulatorDeps {
  readonly store: EmulatorStore;
  readonly signer: RsaSigner;
  /** Where one-time codes go: FakeChannel in specs, the console (later Mailpit) locally. */
  readonly channel: NotificationChannel;
  readonly clock: Clock;
  readonly config: EmulatorConfig;
}

export class AuthEmulator {
  readonly #store: EmulatorStore;
  readonly #signer: RsaSigner;
  readonly #channel: NotificationChannel;
  readonly #clock: Clock;
  readonly #config: EmulatorConfig;

  constructor(deps: AuthEmulatorDeps) {
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#channel = deps.channel;
    this.#clock = deps.clock;
    this.#config = deps.config;
  }

  get jwks() {
    return this.#signer.jwks;
  }

  /** Always the same answer; a code is sent only to an enabled client that is not locked. */
  async startEmailOtp(rawEmail: string): Promise<SignInStep> {
    const email = normaliseEmail(rawEmail);
    const user = await this.#store.findUserByEmail(email);
    const usable =
      user?.enabled === true && user.role === 'client' && !(await this.#isLocked(email));
    const code = numericCode(this.#config.otpDigits);
    const session = await this.#newSession({
      kind: 'email_otp',
      email,
      ...(usable ? { userId: user.userId, codeHash: sha256(code) } : {}),
    });
    if (usable) {
      const minutes = Math.round(this.#config.otpValiditySeconds / 60);
      // A failed delivery must not change the answer, or it would tell clients from strangers.
      await this.#channel
        .send({
          channel: 'email',
          notificationKey: `AUTH_OTP#${session.sessionId}`,
          to: email,
          subject: 'Il tuo codice di accesso',
          text: `Il tuo codice di accesso a Fisio Calendar è ${code}.\nÈ valido per ${minutes} minuti. Se non l'hai chiesto tu, ignora questo messaggio.`,
        })
        .catch((error: unknown) => console.error('[auth-emulator] code not delivered', error));
    }
    return { kind: 'challenge', challenge: 'EMAIL_OTP', session: session.sessionId };
  }

  async answerEmailOtp(sessionId: string, code: string): Promise<AuthTokens> {
    const session = await this.#openSession(sessionId, 'email_otp');
    if (this.#expired(session)) {
      await this.#store.deleteSession(sessionId);
      throw new AuthError('code_expired');
    }
    if (!session.codeHash || !sameSecret(sha256(code), session.codeHash)) {
      return this.#refuse(session, 'code_mismatch');
    }
    const user = await this.#usableUser(session.userId);
    await this.#spend(sessionId);
    return this.#signIn(user);
  }

  async signInWithPassword(rawEmail: string, password: string): Promise<SignInStep> {
    const email = normaliseEmail(rawEmail);
    if (await this.#isLocked(email)) throw new AuthError('too_many_attempts');
    const user = await this.#store.findUserByEmail(email);
    if (!user?.enabled || !user.passwordHash || !passwordMatches(password, user.passwordHash)) {
      return this.#refuse({ email }, 'not_authorized');
    }
    if (!user.totpEnabled) return { kind: 'signedIn', tokens: await this.#signIn(user) };
    if (!user.totpSecret) throw new AuthError('not_authorized');
    const session = await this.#newSession({ kind: 'totp', email, userId: user.userId });
    return { kind: 'challenge', challenge: 'SOFTWARE_TOKEN_MFA', session: session.sessionId };
  }

  async answerTotp(sessionId: string, code: string): Promise<AuthTokens> {
    const session = await this.#openSession(sessionId, 'totp');
    if (this.#expired(session)) throw new AuthError('invalid_session');
    const user = await this.#usableUser(session.userId);
    const step = user.totpSecret ? await this.#totpStep(user.totpSecret, code) : undefined;
    // A code already used (here or at enrolment) is refused like a wrong one, as on Cognito.
    if (step === undefined || !(await this.#store.acceptTotpStep(user.userId, step))) {
      return this.#refuse(session, 'code_mismatch');
    }
    await this.#spend(sessionId);
    return this.#signIn(user);
  }

  /**
   * Step one of the setup link (§11.5): checks the one-time setup code and the new password,
   * and returns a fresh TOTP secret. Nothing is stored on the user until {@link verifyTotpSetup}.
   */
  async startSetup(setupCode: string, newPassword: string): Promise<TotpEnrolment> {
    const codeHash = sha256(setupCode);
    const record = await this.#store.getSetup(codeHash);
    const user = record ? await this.#store.getUser(record.userId) : undefined;
    if (
      !record ||
      !user?.enabled ||
      user.setupCodeHash !== codeHash ||
      this.#clock.now().toISOString() >= record.expiresAt
    ) {
      throw new AuthError('not_authorized');
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw new AuthError('invalid_password');
    const secret = generateSecret();
    const session = await this.#newSession({
      kind: 'totp_setup',
      email: user.email,
      userId: user.userId,
      pendingTotpSecret: secret,
      pendingPasswordHash: hashPassword(newPassword),
      setupCodeHash: codeHash,
    });
    return {
      session: session.sessionId,
      secret,
      otpauthUri: generateURI({ issuer: TOTP_ISSUER, label: user.email, secret }),
    };
  }

  /**
   * Step two: the first TOTP code proves the enrolment; the password and secret are stored, and
   * the setup code is retired. Only while that code is still the user's live one: a second
   * session opened with it, or one opened with a code a bootstrap re-run replaced, is refused.
   */
  async verifyTotpSetup(sessionId: string, code: string): Promise<AuthTokens> {
    const session = await this.#openSession(sessionId, 'totp_setup');
    if (this.#expired(session)) throw new AuthError('invalid_session');
    const user = await this.#usableUser(session.userId);
    const { pendingTotpSecret, pendingPasswordHash, setupCodeHash } = session;
    if (!pendingTotpSecret || !pendingPasswordHash || !setupCodeHash) {
      throw new AuthError('invalid_session');
    }
    if (user.setupCodeHash !== setupCodeHash) throw new AuthError('not_authorized');
    const step = await this.#totpStep(pendingTotpSecret, code);
    if (step === undefined) return this.#refuse(session, 'code_mismatch');
    await this.#spend(sessionId);
    const fields = {
      passwordHash: pendingPasswordHash,
      totpSecret: pendingTotpSecret,
      lastTotpStep: step,
    };
    if (!(await this.#store.completeSetup(user.userId, setupCodeHash, fields))) {
      throw new AuthError('not_authorized');
    }
    await this.#store.deleteSetup(setupCodeHash);
    return this.#signIn({ ...user, ...fields, setupCodeHash: undefined });
  }

  /** New tokens for a refresh token, which is spent: the answer carries its replacement. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const hash = sha256(refreshToken);
    const record = await this.#store.getRefresh(hash);
    if (!record) throw new AuthError('not_authorized');
    const user = await this.#store.getUser(record.userId);
    const valid =
      user?.enabled === true &&
      user.tokenGeneration === record.tokenGeneration &&
      this.#clock.now().toISOString() < record.expiresAt;
    // Spent either way; a concurrent use of the same token finds it gone.
    const taken = await this.#store.takeRefresh(hash);
    if (!valid || !taken) throw new AuthError('not_authorized');
    return this.#issue(user, record);
  }

  async #signIn(user: StoredUser): Promise<AuthTokens> {
    await this.#store.clearAttempts(user.email);
    return this.#issue(user);
  }

  async #issue(
    user: StoredUser,
    chain?: { readonly signedInAt: string; readonly expiresAt: string },
  ): Promise<AuthTokens> {
    const config = this.#config;
    const now = this.#clock.now();
    const signedInAt = chain?.signedInAt ?? now.toISOString();
    const expiresAt =
      chain?.expiresAt ??
      new Date(now.getTime() + config.refreshTokenDays[user.role] * MS_PER_DAY).toISOString();
    const iat = Math.floor(now.getTime() / 1000);
    const common = {
      sub: user.userId,
      iss: config.issuer,
      iat,
      exp: iat + config.accessTokenSeconds,
      auth_time: Math.floor(new Date(signedInAt).getTime() / 1000),
      'cognito:groups': [user.role],
      role: user.role,
      tenantId: config.tenantId,
    };
    const refreshToken = randomToken();
    await this.#store.putRefresh(sha256(refreshToken), {
      userId: user.userId,
      signedInAt,
      expiresAt,
      tokenGeneration: user.tokenGeneration,
    });
    return {
      accessToken: this.#signer.sign({
        ...common,
        token_use: 'access',
        client_id: config.clientId,
        scope: 'aws.cognito.signin.user.admin',
        username: user.userId,
        jti: randomToken(16),
      }),
      idToken: this.#signer.sign({
        ...common,
        token_use: 'id',
        aud: config.clientId,
        email: user.email,
        email_verified: true,
        'cognito:username': user.userId,
        jti: randomToken(16),
      }),
      refreshToken,
      expiresIn: config.accessTokenSeconds,
    };
  }

  async #newSession(fields: Omit<Session, 'sessionId' | 'expiresAt'>): Promise<Session> {
    const session: Session = {
      ...fields,
      sessionId: randomToken(),
      expiresAt: new Date(
        this.#clock.now().getTime() + this.#config.otpValiditySeconds * 1000,
      ).toISOString(),
    };
    await this.#store.putSession(session);
    return session;
  }

  /** The session if it exists, has this kind and its email is not locked. */
  async #openSession(sessionId: string, kind: Session['kind']): Promise<Session> {
    const session = await this.#store.getSession(sessionId);
    if (session?.kind !== kind) throw new AuthError('invalid_session');
    if (await this.#isLocked(session.email)) throw new AuthError('too_many_attempts');
    return session;
  }

  /** Ends a session that was answered; a concurrent answer that spent it first wins. */
  async #spend(sessionId: string): Promise<void> {
    if (!(await this.#store.takeSession(sessionId))) throw new AuthError('invalid_session');
  }

  #expired(session: Session): boolean {
    return this.#clock.now().toISOString() >= session.expiresAt;
  }

  async #usableUser(userId: string | undefined): Promise<StoredUser> {
    const user = userId ? await this.#store.getUser(userId) : undefined;
    if (!user?.enabled) throw new AuthError('not_authorized');
    return user;
  }

  /**
   * The time step of a matching TOTP code, or undefined. A malformed code never reaches otplib;
   * an otplib failure is an internal error, not a wrong code counted toward the lockout.
   */
  async #totpStep(secret: string, code: string): Promise<number | undefined> {
    if (!TOTP_CODE.test(code)) return undefined;
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(this.#clock.now().getTime() / 1000),
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    });
    return result.valid && 'timeStep' in result ? result.timeStep : undefined;
  }

  async #isLocked(email: string): Promise<boolean> {
    const attempts = await this.#store.getAttempts(email);
    return (
      attempts?.lockedUntil !== undefined && this.#clock.now().toISOString() < attempts.lockedUntil
    );
  }

  /**
   * Counts a wrong code or password for the email (within the lockout window) and throws:
   * `code` normally, `too_many_attempts` at the threshold, which also ends the session.
   */
  async #refuse(
    session: Pick<Session, 'email'> & Partial<Session>,
    code: AuthErrorCode,
  ): Promise<never> {
    const now = this.#clock.now();
    const window = this.#config.lockoutSeconds;
    const failures = await this.#store.recordFailure(session.email, now, window);
    if (failures < this.#config.maxFailedAttempts) throw new AuthError(code);
    await this.#store.lockAttempts(
      session.email,
      new Date(now.getTime() + window * 1000).toISOString(),
    );
    if (session.sessionId) await this.#store.deleteSession(session.sessionId);
    throw new AuthError('too_many_attempts');
  }
}
