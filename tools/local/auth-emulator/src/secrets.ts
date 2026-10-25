import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/** Hashing and random values for the emulator: codes, tokens and passwords are never stored. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A numeric one-time code with leading zeros kept, e.g. `04718263`. */
export function numericCode(digits: number): string {
  return Array.from({ length: digits }, () => randomInt(10)).join('');
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `scrypt$<salt>$<hash>`. Strong enough for a local stand-in; Cognito owns real passwords. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('base64url')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  return sameSecret(scryptSync(password, salt, 32).toString('base64url'), hash);
}
