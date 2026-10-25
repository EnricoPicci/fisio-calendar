/**
 * The emulator's own DynamoDB keys. It plays Cognito, whose storage is not application data, so
 * its items live under `IDP#<poolId>` in the same table and never share a prefix with the
 * application's `T#<tid>` keys; this module is the one exception to "keys are built only in
 * apps/api/src/repo" (CLAUDE.md convention 3). A pool id per spec file keeps specs parallel-safe,
 * like a fresh tenant does for the API (docs/architecture.md §10.3).
 */
export function poolPk(poolId: string): string {
  return `IDP#${poolId}`;
}

export function userSk(userId: string): string {
  return `USER#${userId}`;
}

/** Holds the email → user id mapping and makes an email unique within the pool. */
export function emailSk(email: string): string {
  return `EMAIL#${email}`;
}

/** Failed attempts and lockout per email, kept whether or not the email belongs to a user. */
export function attemptsSk(email: string): string {
  return `ATTEMPTS#${email}`;
}

export function sessionSk(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

/** Refresh tokens and setup codes are stored by their SHA-256, never in clear. */
export function refreshSk(tokenHash: string): string {
  return `REFRESH#${tokenHash}`;
}

export function setupSk(codeHash: string): string {
  return `SETUP#${codeHash}`;
}
