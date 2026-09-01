import { describe, expect, it } from "vitest";

import { makeScryptPasswordHasher, SCRYPT_N, SCRYPT_R } from "../scrypt-password-hasher";

/**
 * The real algorithm, at a REDUCED cost (N=2^10 instead of 2^15) so the suite
 * runs in milliseconds. The cost is a parameter of the format, which is exactly
 * the property being tested: a digest carries its own N/r/p, so today's hasher
 * verifies yesterday's rows.
 *
 * One test below does run at PRODUCTION cost — that is the one that proves the
 * `maxmem` bump is real (without it, scrypt throws on every call at 2^15).
 */

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = "Str0ng!pass";

function cheapHasher() {
  return makeScryptPasswordHasher({ cost: CHEAP });
}

// --- Refusals / hostile inputs first ------------------------------------------

describe("verify — anything unusable reads as 'wrong password'", () => {
  it.each([
    ["an empty stored value", ""],
    ["a non-string", null],
    ["the wrong prefix", "bcrypt$1024$8$1$c2FsdA==$a2V5"],
    ["too few segments", "scrypt$1024$8$1$c2FsdA=="],
    ["a non-numeric N", "scrypt$abc$8$1$c2FsdA==$a2V5"],
    ["an N that is not a power of two", "scrypt$1000$8$1$c2FsdA==$a2V5"],
    ["an empty salt", "scrypt$1024$8$1$$a2V5"],
    ["an empty key", "scrypt$1024$8$1$c2FsdA==$"],
  ])("returns false for %s — it never throws", async (_label, stored) => {
    const hasher = cheapHasher();
    await expect(hasher.verify(PASSWORD, stored as string)).resolves.toBe(false);
  });

  it("refuses a hand-edited row demanding absurd memory", async () => {
    // 128*N*r for N=2^30 is ~1 TB. Without this guard a single crafted row
    // could take the process down through the password field.
    const hasher = cheapHasher();
    await expect(hasher.verify(PASSWORD, `scrypt$${2 ** 30}$8$1$c2FsdA==$a2V5`)).resolves.toBe(
      false,
    );
  });

  it("returns false for an empty candidate password", async () => {
    const hasher = cheapHasher();
    const stored = await hasher.hash(PASSWORD);
    await expect(hasher.verify("", stored)).resolves.toBe(false);
  });

  it("refuses to hash an empty password at all", async () => {
    const hasher = cheapHasher();
    await expect(hasher.hash("")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// --- Happy path ---------------------------------------------------------------

describe("hash + verify", () => {
  it("accepts the right password and refuses a near miss", async () => {
    const hasher = cheapHasher();
    const stored = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
    await expect(hasher.verify(`${PASSWORD} `, stored)).resolves.toBe(false);
    await expect(hasher.verify(PASSWORD.toLowerCase(), stored)).resolves.toBe(false);
  });

  it("salts every hash — two rows for one password never match", async () => {
    const hasher = cheapHasher();
    const [a, b] = await Promise.all([hasher.hash(PASSWORD), hasher.hash(PASSWORD)]);
    expect(a).not.toBe(b);
    await expect(hasher.verify(PASSWORD, b)).resolves.toBe(true);
  });

  it("stores the parameters WITH the digest", async () => {
    const hasher = cheapHasher();
    const stored = await hasher.hash(PASSWORD);
    expect(stored.split("$").slice(0, 4)).toEqual(["scrypt", "1024", "8", "1"]);
    expect(stored.split("$")).toHaveLength(6);
  });

  it("verifies a row written at a DIFFERENT cost than today's", async () => {
    // The property that makes raising the cost later a config change instead of
    // a forced password reset for everybody.
    const old = makeScryptPasswordHasher({ cost: { N: 256, r: 8, p: 1 } });
    const today = makeScryptPasswordHasher({ cost: CHEAP });
    const stored = await old.hash(PASSWORD);
    await expect(today.verify(PASSWORD, stored)).resolves.toBe(true);
  });

  it("does not leak the password into the stored value", async () => {
    const hasher = cheapHasher();
    const stored = await hasher.hash(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
  });

  it("burns CPU without ever matching anything", async () => {
    const hasher = cheapHasher();
    await expect(hasher.burn(PASSWORD)).resolves.toBeUndefined();
    // Also survives the degenerate input the usecase can hand it.
    await expect(hasher.burn("")).resolves.toBeUndefined();
  });
});

describe("production parameters", () => {
  it(`runs at N=${SCRYPT_N}, r=${SCRYPT_R} — proving the maxmem bump is needed and applied`, async () => {
    // Node's default maxmem is 32 MB and 128*N*r here is ~33.5 MB: without the
    // explicit maxmem this call throws ERR_CRYPTO_INVALID_SCRYPT_PARAM.
    const hasher = makeScryptPasswordHasher();
    const stored = await hasher.hash(PASSWORD);
    expect(stored.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$1$`)).toBe(true);
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
  }, 20_000);
});
