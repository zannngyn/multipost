/**
 * Password hashing, as a need rather than an algorithm (docs/07 §3.2).
 * Pure TypeScript: no imports. `node:crypto` lives in `adapters/auth/`.
 *
 * Contract for every implementer:
 * - `hash` returns a SELF-DESCRIBING string: the parameters and the salt travel
 *   with the digest, so raising the cost later does not invalidate old rows —
 *   `verify` re-reads the parameters from the stored value, never from today's
 *   constants;
 * - `verify` is CONSTANT TIME against the stored digest and returns `false` for
 *   anything it cannot parse. It never throws on a malformed stored value: a
 *   corrupt row must read as "wrong password", not as a 500 that tells the
 *   caller the row exists;
 * - `burn` costs the same as `verify` and answers nothing. The usecase calls it
 *   on the "no such e-mail" branch so that branch takes as long as a wrong
 *   password — without it, response time alone enumerates who has an account.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
  burn(plain: string): Promise<void>;
}
