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

// A password hash that no string satisfies.
//
// For accounts that must EXIST before anybody holds a credential for them. The
// 32 random bytes go into argon2 and are discarded on the same line: there is
// no plaintext to return in a response body, read out over a counter, paste
// into a chat, or find in a heap dump. The way in is proving the mailbox.
//
// This replaced a randomPassword() helper whose output was handed to whoever
// created the account. That made the first credential of every staff account
// known to somebody other than its owner — and put it in an API response,
// which is the one place a password must never be.
export const unusableCredential = () => hashPassword(randomBytes(32).toString('base64url'));
