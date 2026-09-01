import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from "@/core/domain/password-credential";
import type { AccountRepo } from "@/core/ports/account-repo";

import {
  credentialRow,
  fixedClock,
  makeFakeCredentialRepo,
  makeFakePasswordHasher,
  silentLogger,
} from "../__fixtures__/credential-repo";
import { makePasswordAuth } from "../password-auth";

/**
 * E-mail + password: refusals first, happy path last (CLAUDE.md rule 1).
 *
 * The three properties every assertion here defends:
 *   1. ONE code for every sign-in refusal, so the error is not an oracle;
 *   2. the lock-out counts, trips at 5 and holds even for the right password;
 *   3. resetting someone else's password is platform-super_admin work, checked
 *      against a FRESH read.
 */

const PASSWORD = "Str0ng!pass";
const T0 = Date.UTC(2026, 7, 24, 9, 0, 0);

/**
 * The AppError a call was expected to reject with. A helper rather than
 * `.catch(e => e as X)` at each site: that pattern types the result as a UNION
 * with the success value, and a test that quietly resolves would then read its
 * assertions off the wrong object instead of failing.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (AppError.is(error)) return error as AppError;
    throw new Error(`Expected an AppError, got: ${String(error)}`);
  }
  throw new Error("Expected the call to be refused, but it resolved");
}

function harness(
  options: {
    rows?: ReturnType<typeof credentialRow>[];
    platformStanding?: { status: "active" | "suspended"; platformRole: "super_admin" | "support" | null } | null;
  } = {},
) {
  const credentials = makeFakeCredentialRepo(options.rows ?? [credentialRow()]);
  const hasher = makeFakePasswordHasher();
  const { clock, advance } = fixedClock(T0);
  const findPlatformStanding = vi.fn(async () => options.platformStanding ?? null);
  const accounts: Pick<AccountRepo, "findPlatformStanding"> = { findPlatformStanding };

  const usecase = makePasswordAuth({
    credentials,
    accounts,
    hasher,
    clock,
    logger: silentLogger(),
  });
  return { usecase, credentials, hasher, advance, findPlatformStanding };
}

// --- Register: refusals first -------------------------------------------------

describe("register — refusals", () => {
  it("refuses a malformed address before it hashes anything", async () => {
    const { usecase, hasher } = harness({ rows: [] });
    await expect(
      usecase.register({ email: "not-an-address", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(hasher.burnCount).toBe(0);
  });

  it.each([
    ["too short", "Ab1!"],
    ["no uppercase", "str0ng!pass"],
    ["no digit", "Strong!pass"],
    ["no symbol", "Str0ngpass"],
    ["missing entirely", undefined],
  ])("refuses a weak password (%s) with AUTH_WEAK_PASSWORD", async (_label, password) => {
    const { usecase } = harness({ rows: [] });
    await expect(
      usecase.register({ email: "new@mysp.vn", password }),
    ).rejects.toMatchObject({ code: "AUTH_WEAK_PASSWORD" });
  });

  it("names every broken rule in Vietnamese, not just the first", async () => {
    const { usecase } = harness({ rows: [] });
    const error = await refusalOf(() =>
      usecase.register({ email: "new@mysp.vn", password: "abc" }),
    );

    expect(error.context.problems).toEqual(["length", "uppercase", "digit", "symbol"]);
    expect(error.userMessage).toContain("ít nhất 8 ký tự");
    expect(error.userMessage).toContain("chữ in hoa");
    expect(error.userMessage).toContain("chữ số");
    expect(error.userMessage).toContain("ký tự đặc biệt");
  });

  it("lets the repo's unique index decide who owns an address (AUTH_EMAIL_TAKEN)", async () => {
    // No pre-flight "does it exist" query: that would be both a TOCTOU gap and
    // a probing oracle. The collision comes back from the write.
    const { usecase } = harness({ rows: [credentialRow({ email: "taken@mysp.vn" })] });
    await expect(
      usecase.register({ email: " Taken@MYSP.vn ", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_TAKEN" });
  });
});

describe("register — happy path", () => {
  it("normalises the address and files the identity under it", async () => {
    const { usecase, credentials } = harness({ rows: [] });
    const identity = await usecase.register({
      email: "  New.Person@MYSP.vn ",
      password: PASSWORD,
      displayName: "  Người Mới  ",
    });

    expect(identity.email).toBe("new.person@mysp.vn");
    // sessionEmail IS the address for a password identity — that is what makes
    // the account resolve through the same path a Google account does.
    expect(identity.sessionEmail).toBe("new.person@mysp.vn");
    expect(identity.displayName).toBe("Người Mới");
    expect(credentials.rows.get("new.person@mysp.vn")?.passwordHash).toBe(`hash:${PASSWORD}`);
  });

  it("keeps an empty display name as null rather than an empty string", async () => {
    const { usecase } = harness({ rows: [] });
    const identity = await usecase.register({
      email: "quiet@mysp.vn",
      password: PASSWORD,
      displayName: "   ",
    });
    expect(identity.displayName).toBeNull();
  });
});

// --- Sign-in: refusals first --------------------------------------------------

describe("signIn — every refusal is the same code", () => {
  it("answers AUTH_INVALID_CREDENTIALS for an address nobody uses", async () => {
    const { usecase } = harness();
    await expect(
      usecase.signIn({ email: "ghost@mysp.vn", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  });

  it("burns the same CPU on the unknown-address branch (no timing oracle)", async () => {
    const { usecase, hasher } = harness();
    await usecase.signIn({ email: "ghost@mysp.vn", password: PASSWORD }).catch(() => {});
    expect(hasher.burnCount).toBe(1);
  });

  it("answers AUTH_INVALID_CREDENTIALS for a wrong password", async () => {
    const { usecase } = harness();
    await expect(
      usecase.signIn({ email: "worker@mysp.vn", password: "Wr0ng!pass" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  });

  it("answers AUTH_INVALID_CREDENTIALS for a SUSPENDED account with the RIGHT password", async () => {
    const { usecase } = harness({ rows: [credentialRow({ accountStatus: "suspended" })] });
    await expect(
      usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  });

  it.each([
    ["malformed address", { email: "nope", password: PASSWORD }],
    ["empty password", { email: "worker@mysp.vn", password: "" }],
    ["missing password", { email: "worker@mysp.vn", password: undefined }],
  ])("answers AUTH_INVALID_CREDENTIALS for %s", async (_label, input) => {
    const { usecase } = harness();
    await expect(usecase.signIn(input)).rejects.toMatchObject({
      code: "AUTH_INVALID_CREDENTIALS",
    });
  });

  it("does not touch the counter when the address is unknown", async () => {
    const { usecase, credentials } = harness();
    await usecase.signIn({ email: "ghost@mysp.vn", password: PASSWORD }).catch(() => {});
    expect(credentials.attemptWrites).toHaveLength(0);
  });
});

describe("signIn — the lock-out", () => {
  it("counts every consecutive failure", async () => {
    const { usecase, credentials } = harness();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await usecase.signIn({ email: "worker@mysp.vn", password: "Wr0ng!pass" }).catch(() => {});
    }
    expect(credentials.attemptWrites.map((write) => write.failedAttempts)).toEqual([1, 2, 3]);
    expect(credentials.attemptWrites.every((write) => write.lockedUntil === null)).toBe(true);
  });

  it(`locks for 15 minutes on failure number ${MAX_FAILED_ATTEMPTS}`, async () => {
    const { usecase, credentials } = harness();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await usecase.signIn({ email: "worker@mysp.vn", password: "Wr0ng!pass" }).catch(() => {});
    }

    await expect(
      usecase.signIn({ email: "worker@mysp.vn", password: "Wr0ng!pass" }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_LOCKED" });

    const last = credentials.attemptWrites.at(-1);
    expect(last?.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(last?.lockedUntil?.getTime()).toBe(T0 + LOCKOUT_MS);
  });

  it("refuses the RIGHT password while the lock holds — and does not hash it", async () => {
    // The whole point: a lock that only stops wrong guesses stops nothing.
    const { usecase, credentials } = harness({
      rows: [
        credentialRow({ failedAttempts: 5, lockedUntil: new Date(T0 + 5 * 60_000) }),
      ],
    });
    await expect(
      usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_LOCKED" });
    // No counter write: a locked-out attempt must not extend its own lock.
    expect(credentials.attemptWrites).toHaveLength(0);
  });

  it("tells the person when they may try again", async () => {
    const { usecase } = harness({
      rows: [credentialRow({ failedAttempts: 5, lockedUntil: new Date(T0 + LOCKOUT_MS) })],
    });
    const error = await refusalOf(() =>
      usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD }),
    );
    // T0 is 09:00 UTC = 16:00 in Asia/Ho_Chi_Minh; +15min = 16:15.
    expect(error.userMessage).toContain("16:15 ngày 24/08/2026");
  });

  it("lets the person back in once the lock has expired", async () => {
    const { usecase, advance } = harness({
      rows: [credentialRow({ failedAttempts: 5, lockedUntil: new Date(T0 + LOCKOUT_MS) })],
    });
    advance(LOCKOUT_MS + 1);
    await expect(
      usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD }),
    ).resolves.toMatchObject({ accountId: "acc-1" });
  });

  it("treats a corrupt counter as 0 rather than refusing to lock at all", async () => {
    const { usecase, credentials } = harness({
      rows: [credentialRow({ failedAttempts: -7 })],
    });
    await usecase.signIn({ email: "worker@mysp.vn", password: "Wr0ng!pass" }).catch(() => {});
    expect(credentials.attemptWrites[0]?.failedAttempts).toBe(1);
  });
});

describe("signIn — happy path", () => {
  it("returns the identity Auth.js needs and nothing more", async () => {
    const { usecase } = harness();
    const identity = await usecase.signIn({ email: " Worker@MYSP.vn ", password: PASSWORD });

    expect(identity).toEqual({
      accountId: "acc-1",
      sessionEmail: "worker@mysp.vn",
      email: "worker@mysp.vn",
      displayName: "Worker",
    });
    // No hash, no counter, no lock — this object ends up inside a JWT.
    expect(Object.keys(identity)).not.toContain("passwordHash");
  });

  it("resets the failure counter", async () => {
    const { usecase, credentials } = harness({ rows: [credentialRow({ failedAttempts: 3 })] });
    await usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD });
    expect(credentials.clearedIds).toEqual(["cred-1"]);
    expect(credentials.rows.get("worker@mysp.vn")?.failedAttempts).toBe(0);
  });

  it("clears a STALE lock that has already expired", async () => {
    const { usecase, credentials } = harness({
      rows: [credentialRow({ failedAttempts: 5, lockedUntil: new Date(T0 - 1) })],
    });
    await usecase.signIn({ email: "worker@mysp.vn", password: PASSWORD });
    expect(credentials.rows.get("worker@mysp.vn")?.lockedUntil).toBeNull();
  });
});

// --- setPassword: refusals first ----------------------------------------------

describe("setPassword — refusals", () => {
  it.each([
    ["no actor", { actorAccountId: "", targetAccountId: "acc-1" }],
    ["no target", { actorAccountId: "acc-9", targetAccountId: "  " }],
  ])("refuses %s with INVALID_INPUT", async (_label, ids) => {
    const { usecase } = harness();
    await expect(usecase.setPassword({ ...ids, newPassword: PASSWORD })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses a weak new password before it reads the actor's standing", async () => {
    const { usecase, findPlatformStanding } = harness();
    await expect(
      usecase.setPassword({
        actorAccountId: "acc-9",
        targetAccountId: "acc-1",
        newPassword: "weak",
      }),
    ).rejects.toMatchObject({ code: "AUTH_WEAK_PASSWORD" });
    expect(findPlatformStanding).not.toHaveBeenCalled();
  });

  it.each([
    ["an ordinary operator", { status: "active" as const, platformRole: null }],
    ["a support agent", { status: "active" as const, platformRole: "support" as const }],
    ["a SUSPENDED super_admin", { status: "suspended" as const, platformRole: "super_admin" as const }],
    ["an account that does not exist", null],
  ])("refuses %s with FORBIDDEN", async (_label, standing) => {
    const { usecase } = harness({ platformStanding: standing });
    await expect(
      usecase.setPassword({
        actorAccountId: "acc-9",
        targetAccountId: "acc-1",
        newPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an OAuth-only target with AUTH_CREDENTIAL_NOT_FOUND", async () => {
    const { usecase } = harness({
      platformStanding: { status: "active", platformRole: "super_admin" },
    });
    await expect(
      usecase.setPassword({
        actorAccountId: "acc-9",
        targetAccountId: "acc-no-password",
        newPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "AUTH_CREDENTIAL_NOT_FOUND" });
  });
});

describe("setPassword — happy path", () => {
  it("replaces the hash and LIFTS the lock in one go", async () => {
    const { usecase, credentials } = harness({
      rows: [credentialRow({ failedAttempts: 5, lockedUntil: new Date(T0 + LOCKOUT_MS) })],
      platformStanding: { status: "active", platformRole: "super_admin" },
    });

    await usecase.setPassword({
      actorAccountId: "acc-9",
      targetAccountId: "acc-1",
      newPassword: "N3w!password",
    });

    const row = credentials.rows.get("worker@mysp.vn");
    expect(row?.passwordHash).toBe("hash:N3w!password");
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it("reads the actor's standing FRESH, never from a cached claim", async () => {
    const { usecase, findPlatformStanding } = harness({
      platformStanding: { status: "active", platformRole: "super_admin" },
    });
    await usecase.setPassword({
      actorAccountId: "acc-9",
      targetAccountId: "acc-1",
      newPassword: "N3w!password",
    });
    expect(findPlatformStanding).toHaveBeenCalledWith("acc-9");
  });
});
