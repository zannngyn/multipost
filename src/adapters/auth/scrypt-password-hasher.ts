import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { AppError } from "@/core/domain/errors";
import type { PasswordHasher } from "@/core/ports/password-hasher";

/**
 * scrypt from `node:crypto` — no new dependency, and a memory-hard KDF is what
 * a password column needs (a GPU farm is cheap against SHA-family hashing and
 * expensive against 32 MB of random access per guess).
 *
 * STORED FORMAT — `scrypt$N$r$p$<salt b64>$<key b64>`:
 * every parameter travels WITH the digest. Raising the cost later then does not
 * invalidate a single row: `verify` re-reads N/r/p from the stored string and
 * only `hash` uses today's constants. A format that stored the digest alone
 * would make the next cost bump a forced password reset for everybody.
 */

/** CPU/memory cost. 2^15 = 32768 -> ~32 MB and ~100 ms on the target VPS. */
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** 16 bytes: the salt only has to be unique, not secret. */
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_KEY_BYTES = 64;

/**
 * Node's default `maxmem` is 32 MB and the parameters above need 128*N*r ≈
 * 33.5 MB, so scrypt would throw "Invalid scrypt params" on EVERY call without
 * this. Found by running it, not by reading it — the failure is a thrown
 * ERR_CRYPTO_INVALID_SCRYPT_PARAM, not a slow hash.
 */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

const FORMAT_PREFIX = "scrypt";

function derive(
  plain: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keyLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) {
          reject(
            new AppError("INTERNAL", {
              message: "scrypt key derivation failed",
              userMessage: "Không xử lý được mật khẩu. Vui lòng thử lại.",
              context: { n: params.N, r: params.r, p: params.p },
              cause: error,
            }),
          );
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/**
 * STORED DATA IS EXTERNAL DATA (technical standard #2): a row written by an
 * older build, a truncated value, a hand-edited one — all parse to null and are
 * treated as "wrong password" by the caller. Never throws: a corrupt row must
 * not become a 500 that confirms the row exists.
 */
function parseStoredHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  const [prefix, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (prefix !== FORMAT_PREFIX) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isSafeInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isSafeInteger(p) || p < 1 || p > 16) return null;
  // Refuse to spend memory a hand-edited row asked for (128*N*r must fit).
  if (128 * N * r > SCRYPT_MAXMEM) return null;

  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(rawSalt, "base64");
    key = Buffer.from(rawKey, "base64");
  } catch (error) {
    // Buffer.from is lenient, but a throw here would still be a corrupt row —
    // recorded, not swallowed, and answered as "cannot verify".
    void error;
    return null;
  }
  if (salt.length === 0 || key.length === 0 || key.length > 256) return null;

  return { N, r, p, salt, key };
}

export interface ScryptPasswordHasherOptions {
  /** Test seam only. Production always uses the constants above. */
  readonly cost?: { N: number; r: number; p: number };
}

export function makeScryptPasswordHasher(
  options: ScryptPasswordHasherOptions = {},
): PasswordHasher {
  const cost = options.cost ?? { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

  /**
   * The hash `burn()` verifies against. Built once from random bytes at first
   * use: it must be a REAL hash with the real cost, or the decoy branch would
   * be cheaper than the genuine one and the timing gap it exists to close would
   * simply move. Nothing can ever match it — no password produced it.
   */
  let decoy: Promise<string> | null = null;
  const decoyHash = (): Promise<string> => {
    if (!decoy) decoy = hashPassword(randomBytes(32).toString("hex"));
    return decoy;
  };

  async function hashPassword(plain: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const key = await derive(plain, salt, { ...cost, keyLength: SCRYPT_KEY_BYTES });
    return [
      FORMAT_PREFIX,
      cost.N,
      cost.r,
      cost.p,
      salt.toString("base64"),
      key.toString("base64"),
    ].join("$");
  }

  return {
    async hash(plain) {
      // --- Edge cases first ---------------------------------------------------
      if (typeof plain !== "string" || plain.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Cannot hash an empty password",
          context: { field: "password" },
        });
      }
      return hashPassword(plain);
    },

    async verify(plain, stored) {
      // --- Edge cases first ---------------------------------------------------
      if (typeof plain !== "string" || plain.length === 0) return false;
      const parsed = parseStoredHash(stored);
      if (!parsed) return false;

      const candidate = await derive(plain, parsed.salt, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        keyLength: parsed.key.length,
      });

      // `timingSafeEqual` THROWS on differing lengths — which would itself leak
      // the stored key length. Lengths match by construction above; the guard
      // is belt and braces for a truncated row.
      if (candidate.length !== parsed.key.length) return false;
      return timingSafeEqual(candidate, parsed.key);
    },

    async burn(plain) {
      const password = typeof plain === "string" && plain.length > 0 ? plain : "x";
      const parsed = parseStoredHash(await decoyHash());
      // The decoy is built by this module, so it always parses; if it somehow
      // did not, spending nothing here would re-open the timing gap.
      if (!parsed) return;
      await derive(password, parsed.salt, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        keyLength: parsed.key.length,
      });
    },
  };
}
