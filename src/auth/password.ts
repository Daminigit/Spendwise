/**
 * src/auth/password.ts
 *
 * Password hashing with argon2id.
 */

import * as argon2 from 'argon2';

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash → treat as mismatch rather than a 500
    return false;
  }
}

// A real hash of a random string, used to equalise timing when the email is unknown.
let dummyHash: Promise<string> | undefined;
export function dummyVerify(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}`);
  return dummyHash.then((h) => verifyPassword(h, plain)).then(() => false);
}
