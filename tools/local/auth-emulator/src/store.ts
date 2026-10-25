import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  IDENTITY_ROLES,
  IdentityUserExistsError,
  IdentityUserNotFoundError,
  isErrorNamed,
} from '@fisio/domain';
import { z } from 'zod';
import { attemptsSk, emailSk, poolPk, refreshSk, sessionSk, setupSk, userSk } from './keys';

/**
 * The emulator's items in DynamoDB Local: users (with a uniqueness item per email), failed
 * attempts per email, sign-in sessions, refresh tokens and setup codes. Expiring items carry the
 * table's `ttl`; the emulator also checks `expiresAt` itself, since TTL deletion is lazy.
 */
export const StoredUserSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  role: z.enum(IDENTITY_ROLES),
  enabled: z.boolean(),
  passwordHash: z.string().optional(),
  totpSecret: z.string().optional(),
  totpEnabled: z.boolean(),
  totpPreferred: z.boolean(),
  /** Bumped by a global sign-out or a disable; refresh tokens of an older value are refused. */
  tokenGeneration: z.number(),
  /** The one live setup code (its hash); an earlier code is refused. */
  setupCodeHash: z.string().optional(),
  /** The last accepted TOTP time step: a code is good once, like Cognito's. */
  lastTotpStep: z.number().optional(),
  createdAt: z.string(),
});
export type StoredUser = z.infer<typeof StoredUserSchema>;

export const SessionSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(['email_otp', 'totp', 'totp_setup']),
  email: z.string(),
  /** Absent for an email that has no usable account: the session exists so nobody can tell. */
  userId: z.string().optional(),
  codeHash: z.string().optional(),
  /** For `totp_setup`: the secret waiting for its first code. */
  pendingTotpSecret: z.string().optional(),
  /** For `totp_setup`: the chosen password, stored on the user once the enrolment completes. */
  pendingPasswordHash: z.string().optional(),
  /** For `totp_setup`: the setup code to retire once the enrolment completes. */
  setupCodeHash: z.string().optional(),
  expiresAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Failures counted until `resetAt`; at the lockout threshold `lockedUntil` = `resetAt`. */
const AttemptsSchema = z.object({
  failures: z.number(),
  lockedUntil: z.string().optional(),
  resetAt: z.string(),
});
export type Attempts = z.infer<typeof AttemptsSchema>;

export const RefreshRecordSchema = z.object({
  userId: z.string(),
  /** The first sign-in of the chain: rotation keeps its expiry. */
  signedInAt: z.string(),
  expiresAt: z.string(),
  tokenGeneration: z.number(),
});
export type RefreshRecord = z.infer<typeof RefreshRecordSchema>;

const SetupRecordSchema = z.object({ userId: z.string(), expiresAt: z.string() });
export type SetupRecord = z.infer<typeof SetupRecordSchema>;

type UserChanges = Partial<Omit<StoredUser, 'userId' | 'email' | 'createdAt'>>;

const epochSeconds = (iso: string) => Math.ceil(new Date(iso).getTime() / 1000);

const isConditionFailure = (error: unknown) =>
  isErrorNamed(error, 'ConditionalCheckFailedException');

/** A transaction cancelled because its first item's condition failed (not a conflict). */
const firstConditionFailed = (error: unknown) =>
  isErrorNamed(error, 'TransactionCanceledException') &&
  (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.[0]?.Code ===
    'ConditionalCheckFailed';

export class EmulatorStore {
  readonly #pk: string;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    poolId: string,
  ) {
    this.#pk = poolPk(poolId);
  }

  async createUser(user: StoredUser): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { PK: this.#pk, SK: emailSk(user.email), userId: user.userId },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { PK: this.#pk, SK: userSk(user.userId), entity: 'IDP_USER', ...user },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (firstConditionFailed(error)) throw new IdentityUserExistsError({ cause: error });
      throw error;
    }
  }

  async getUser(userId: string): Promise<StoredUser | undefined> {
    const item = await this.#get(userSk(userId));
    return item ? StoredUserSchema.parse(item) : undefined;
  }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const link = await this.#get(emailSk(email));
    return link ? this.getUser(String(link.userId)) : undefined;
  }

  /** Sets user fields (`undefined` values are skipped); a missing user is not found. */
  async updateUser(userId: string, changes: UserChanges): Promise<void> {
    const set = Object.entries(changes).filter(([, value]) => value !== undefined);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: userSk(userId) },
          UpdateExpression: `SET ${set.map((_, index) => `#f${index} = :v${index}`).join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: Object.fromEntries(
            set.map(([field], index) => [`#f${index}`, field]),
          ),
          ExpressionAttributeValues: Object.fromEntries(
            set.map(([, value], index) => [`:v${index}`, value]),
          ),
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new IdentityUserNotFoundError({ cause: error });
      throw error;
    }
  }

  /** Ends every refresh token issued so far, atomically (two concurrent bumps both count). */
  async bumpTokenGeneration(userId: string, changes: { enabled?: boolean } = {}): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: userSk(userId) },
          UpdateExpression:
            changes.enabled === undefined
              ? 'ADD tokenGeneration :one'
              : 'SET enabled = :enabled ADD tokenGeneration :one',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':one': 1,
            ...(changes.enabled === undefined ? {} : { ':enabled': changes.enabled }),
          },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new IdentityUserNotFoundError({ cause: error });
      throw error;
    }
  }

  /**
   * Stores the setup's password and TOTP secret if `setupCodeHash` is still the user's live code,
   * and retires it: of two sessions opened with one code, or one opened with a replaced code,
   * only a live one wins. False when the code is no longer live.
   */
  async completeSetup(
    userId: string,
    setupCodeHash: string,
    fields: { passwordHash: string; totpSecret: string; lastTotpStep: number },
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: userSk(userId) },
          UpdateExpression:
            'SET passwordHash = :password, totpSecret = :secret, lastTotpStep = :step REMOVE setupCodeHash',
          ConditionExpression: 'setupCodeHash = :code',
          ExpressionAttributeValues: {
            ':password': fields.passwordHash,
            ':secret': fields.totpSecret,
            ':step': fields.lastTotpStep,
            ':code': setupCodeHash,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  /** Records a TOTP time step as used; false when it (or a later one) was already used. */
  async acceptTotpStep(userId: string, step: number): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: userSk(userId) },
          UpdateExpression: 'SET lastTotpStep = :step',
          ConditionExpression:
            'attribute_exists(PK) AND (attribute_not_exists(lastTotpStep) OR lastTotpStep < :step)',
          ExpressionAttributeValues: { ':step': step },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async deleteUser(user: StoredUser): Promise<void> {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: { PK: this.#pk, SK: userSk(user.userId) } } },
          { Delete: { TableName: this.table, Key: { PK: this.#pk, SK: emailSk(user.email) } } },
        ],
      }),
    );
  }

  async getAttempts(email: string): Promise<Attempts | undefined> {
    const item = await this.#get(attemptsSk(email));
    return item ? AttemptsSchema.parse(item) : undefined;
  }

  /**
   * Counts one failure for the email, atomically, and returns the count in the current window
   * (`windowSeconds` from its first failure): parallel wrong guesses are all counted.
   */
  async recordFailure(email: string, now: Date, windowSeconds: number): Promise<number> {
    const key = { PK: this.#pk, SK: attemptsSk(email) };
    const resetAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();
    for (let round = 0; round < 3; round++) {
      try {
        const { Attributes } = await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: key,
            UpdateExpression: 'ADD failures :one',
            ConditionExpression: 'resetAt > :now',
            ExpressionAttributeValues: { ':one': 1, ':now': now.toISOString() },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return AttemptsSchema.parse(Attributes).failures;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
      // No live window: open one, unless a concurrent failure has just done so.
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: { ...key, failures: 1, resetAt, ttl: epochSeconds(resetAt) },
            ConditionExpression: 'attribute_not_exists(PK) OR resetAt <= :now',
            ExpressionAttributeValues: { ':now': now.toISOString() },
          }),
        );
        return 1;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    throw new Error('The failed-attempt counter stayed contended');
  }

  /**
   * Locks the email until `lockedUntil`; the count restarts after it. A count that a concurrent
   * successful sign-in has just cleared stays cleared.
   */
  async lockAttempts(email: string, lockedUntil: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: attemptsSk(email) },
          UpdateExpression: 'SET lockedUntil = :until, resetAt = :until, #ttl = :ttl',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':until': lockedUntil, ':ttl': epochSeconds(lockedUntil) },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  async clearAttempts(email: string): Promise<void> {
    await this.#delete(attemptsSk(email));
  }

  async putSession(session: Session): Promise<void> {
    await this.#put(sessionSk(session.sessionId), session, session.expiresAt);
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const item = await this.#get(sessionSk(sessionId));
    return item ? SessionSchema.parse(item) : undefined;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#delete(sessionSk(sessionId));
  }

  /** Removes a session once; false when a concurrent answer already spent it. */
  async takeSession(sessionId: string): Promise<boolean> {
    return this.#deleteExisting(sessionSk(sessionId));
  }

  async putRefresh(tokenHash: string, record: RefreshRecord): Promise<void> {
    await this.#put(refreshSk(tokenHash), record, record.expiresAt);
  }

  async getRefresh(tokenHash: string): Promise<RefreshRecord | undefined> {
    const item = await this.#get(refreshSk(tokenHash));
    return item ? RefreshRecordSchema.parse(item) : undefined;
  }

  /** Removes a refresh token once; false when it was already gone (a reused token). */
  async takeRefresh(tokenHash: string): Promise<boolean> {
    return this.#deleteExisting(refreshSk(tokenHash));
  }

  async putSetup(codeHash: string, record: SetupRecord): Promise<void> {
    await this.#put(setupSk(codeHash), record, record.expiresAt);
  }

  async getSetup(codeHash: string): Promise<SetupRecord | undefined> {
    const item = await this.#get(setupSk(codeHash));
    return item ? SetupRecordSchema.parse(item) : undefined;
  }

  async deleteSetup(codeHash: string): Promise<void> {
    await this.#delete(setupSk(codeHash));
  }

  async #get(sk: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: this.#pk, SK: sk },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  async #put(sk: string, fields: object, expiresAt: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: this.#pk, SK: sk, ...fields, ttl: epochSeconds(expiresAt) },
      }),
    );
  }

  async #delete(sk: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: this.#pk, SK: sk } }),
    );
  }

  async #deleteExisting(sk: string): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: sk },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}
