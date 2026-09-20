import { createHash, randomBytes } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

export const hashPassword = (plain) => argon2Hash(plain);

export const verifyPassword = async (hashed, plain) => {
  try {
    return await argon2Verify(hashed, plain);
  } catch {
    return false;
  }
};

// Sessions are looked up by the hash of the JWT, never the JWT itself, so a
// database read can never yield a usable credential.
export const hashSecret = (value) => createHash('sha256').update(value).digest('hex');

export const randomPassword = (bytes = 9) => randomBytes(bytes).toString('base64url');
