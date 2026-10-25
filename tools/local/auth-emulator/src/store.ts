import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { IDENTITY_ROLES, IdentityUserExistsError, IdentityUserNotFoundError } from '@fisio/domain';
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
  /** Bumped by a global sign-out; refresh tokens issued under an older value are refused. */
  tokenGeneration: z.number(),
  /** The one live setup code (its hash); an earlier code is refused. */
  setupCodeHash: z.string().optional(),
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
  (error as { name?: unknown }).name === 'ConditionalCheckFailedException';

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
      if ((error as { name?: unknown }).name === 'TransactionCanceledException') {
        throw new IdentityUserExistsError({ cause: error });
      }
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

  /** Sets (or, for `undefined` values, removes) user fields; a missing user is not found. */
  async updateUser(userId: string, changes: UserChanges): Promise<void> {
    const set = Object.entries(changes).filter(([, value]) => value !== undefined);
    const remove = Object.entries(changes).filter(([, value]) => value === undefined);
    const names = Object.fromEntries(
      [...set, ...remove].map(([field], index) => [`#f${index}`, field]),
    );
    const values = Object.fromEntries(set.map(([, value], index) => [`:v${index}`, value]));
    const clauses = [
      set.length ? `SET ${set.map((_, index) => `#f${index} = :v${index}`).join(', ')}` : '',
      remove.length
        ? `REMOVE ${remove.map((_, index) => `#f${set.length + index}`).join(', ')}`
        : '',
    ];
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.#pk, SK: userSk(userId) },
          UpdateExpression: clauses.filter(Boolean).join(' '),
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: names,
          ...(set.length ? { ExpressionAttributeValues: values } : {}),
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new IdentityUserNotFoundError({ cause: error });
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

  async putAttempts(email: string, attempts: Attempts): Promise<void> {
    await this.#put(attemptsSk(email), attempts, attempts.resetAt);
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
