import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makePasswordAuth } from "@/core/usecases/password-auth";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { DrizzleAccountRepo } from "./account-repo.drizzle";
import { makeDbHandle } from "./client";
import { DrizzleCredentialRepo } from "./credential-repo.drizzle";
import { accounts, auditLogs, credentials, identities } from "./schema";
import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { makeScryptPasswordHasher } from "@/adapters/auth/scrypt-password-hasher";

/**
 * The password write paths a stubbed query builder cannot honestly fake — this
 * file exists because every bug worth catching here lives in the SQL:
 *
 * 1. `register` writes account + identity(provider='password') + credential +
 *    audit in ONE transaction, and the shape it leaves behind must be the same
 *    one a first OAuth sign-in leaves (active account, one identity, zero
 *    memberships) — otherwise a password person is a second kind of person;
 * 2. a duplicate address is refused by the UNIQUE INDEX as AUTH_EMAIL_TAKEN and
 *    the whole transaction rolls back — no orphan account survives;
 * 3. `findByEmail` really joins credential -> account -> identity and picks the
 *    PASSWORD identity, not whichever identity the account happens to have;
 * 4. `account.status='suspended'` reaches the sign-in decision through that
 *    join (the platform ban must close the password door too);
 * 5. the whole lock-out cycle survives a round trip: five wrong passwords
 *    persist a lock, and an admin reset lifts it.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/credential-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

const PASSWORD = "Str0ng!pass";
const NEW_PASSWORD = "An0ther!pass";

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

describe.skipIf(!url)("DrizzleCredentialRepo — the password write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const logger = silentLogger();
  const credentialRepo = new DrizzleCredentialRepo(handle.db, { logger });
  const accountRepo = new DrizzleAccountRepo(handle.db, { logger });

  /**
   * REDUCED scrypt cost. The format, not the cost, is what this file exercises,
   * and 2^15 five times per lock-out test would make the suite unrunnable.
   */
  const hasher = makeScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });

  let now = new Date(Date.UTC(2026, 7, 24, 9, 0, 0));
  const clock = { now: () => now, nowMs: () => now.getTime() };
  const usecase = makePasswordAuth({
    credentials: credentialRepo,
    accounts: accountRepo,
    hasher,
    clock,
    logger,
  });

  /** Unique per run so parallel/leftover rows can never collide. */
  const suffix = randomUUID().slice(0, 8);
  const email = (name: string) => `${name}-${suffix}@example.org`;

  const clean = async () => {
    // `identity` and `account` are GLOBAL tables — remove only this run's rows,
    // recognisable by the suffix. Deleting the account cascades to its identity
    // and its credential.
    const mine = await handle.db
      .select({ accountId: identities.accountId, sessionEmail: identities.sessionEmail })
      .from(identities);
    const ownedAccountIds = [
      ...new Set(
        mine.filter((row) => row.sessionEmail.includes(suffix)).map((row) => row.accountId),
      ),
    ];
    if (ownedAccountIds.length > 0) {
      await handle.db.delete(auditLogs).where(inArray(auditLogs.entityId, ownedAccountIds));
      await handle.db.delete(accounts).where(inArray(accounts.id, ownedAccountIds));
    }
  };

  // Writes global identity rows — same serialisation as the other identity files.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");
  beforeAll(() => globalLock.acquire());

  beforeEach(async () => {
    now = new Date(Date.UTC(2026, 7, 24, 9, 0, 0));
    await clean();
  });

  afterAll(async () => {
    await clean();
    await globalLock.release();
    await handle.close();
  });

  // --- Refusals first --------------------------------------------------------

  it("refuses a duplicate address with AUTH_EMAIL_TAKEN and leaves NO orphan account", async () => {
    const address = email("dup");
    await usecase.register({ email: address, password: PASSWORD });

    const before = await handle.db.select({ id: accounts.id }).from(accounts);
    await expect(
      usecase.register({ email: address.toUpperCase(), password: PASSWORD }),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_TAKEN" });

    // The whole transaction rolled back: the failed sign-up created nothing.
    const after = await handle.db.select({ id: accounts.id }).from(accounts);
    expect(after).toHaveLength(before.length);
  });

  it("closes the password door for a SUSPENDED account (the join carries the ban)", async () => {
    const address = email("banned");
    const identity = await usecase.register({ email: address, password: PASSWORD });
    await handle.db
      .update(accounts)
      .set({ status: "suspended" })
      .where(eq(accounts.id, identity.accountId));

    await expect(usecase.signIn({ email: address, password: PASSWORD })).rejects.toMatchObject({
      code: "AUTH_INVALID_CREDENTIALS",
    });
  });

  it("answers null for an address with no credential", async () => {
    await expect(credentialRepo.findByEmail(email("ghost"))).resolves.toBeNull();
  });

  it("refuses an empty address rather than matching whoever has ''", async () => {
    await expect(credentialRepo.findByEmail("   ")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("answers false when the target account has no password (OAuth-only)", async () => {
    const oauthOnly = await accountRepo.provisionAccount({
      provider: "google",
      providerAccountId: `sub-${suffix}`,
      sessionEmail: email("google-person"),
      email: email("google-person"),
      displayName: "Google Person",
    });

    await expect(
      credentialRepo.replacePasswordHash({
        targetAccountId: oauthOnly.accountId,
        passwordHash: "scrypt$1024$8$1$c2FsdA==$a2V5",
        actorAccountId: "00000000-0000-0000-0000-000000000001",
      }),
    ).resolves.toBe(false);
  });

  // --- Happy path ------------------------------------------------------------

  it("register writes account + identity + credential + audit in ONE transaction", async () => {
    const address = email("newcomer");
    const identity = await usecase.register({
      email: address.toUpperCase(),
      password: PASSWORD,
      displayName: "Người Mới",
    });

    // The address is normalised on the way in — the unique index depends on it.
    expect(identity.email).toBe(address);
    expect(identity.sessionEmail).toBe(address);

    const identityRows = await handle.db
      .select()
      .from(identities)
      .where(eq(identities.accountId, identity.accountId));
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].provider).toBe("password");
    // No third-party `sub` exists: the address IS the identity key.
    expect(identityRows[0].providerAccountId).toBe(address);

    const credentialRows = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.accountId, identity.accountId));
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].failedAttempts).toBe(0);
    expect(credentialRows[0].lockedUntil).toBeNull();
    // The stored value is a self-describing scrypt digest, never the password.
    expect(credentialRows[0].passwordHash.startsWith("scrypt$")).toBe(true);
    expect(credentialRows[0].passwordHash).not.toContain(PASSWORD);

    const audit = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, identity.accountId));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("auth.password_registered");
    // Account-level event: it belongs to no company (see schema/audit-log.ts).
    expect(audit[0].tenantId).toBeNull();
  });

  it("leaves the SAME shape a first OAuth sign-in leaves (the NoMembership lobby)", async () => {
    const identity = await usecase.register({ email: email("lobby"), password: PASSWORD });

    // The proof that nothing downstream needs to learn a second kind of person:
    // the ordinary per-request session lookup resolves this account.
    const summary = await accountRepo.findAccountBySessionEmail(identity.sessionEmail);
    expect(summary?.accountId).toBe(identity.accountId);
    expect(summary?.status).toBe("active");
    expect(summary?.platformRole).toBeNull();
    expect(summary?.identity.provider).toBe("password");
    expect(summary?.activeMemberships).toEqual([]);
  });

  it("signs in, case-insensitively, and returns no secret", async () => {
    const address = email("worker");
    await usecase.register({ email: address, password: PASSWORD, displayName: "Worker" });

    const identity = await usecase.signIn({ email: `  ${address.toUpperCase()} `, password: PASSWORD });
    expect(identity).toEqual({
      accountId: expect.any(String),
      sessionEmail: address,
      email: address,
      displayName: "Worker",
    });
  });

  it("persists the whole lock-out cycle across round trips", async () => {
    const address = email("locked");
    await usecase.register({ email: address, password: PASSWORD });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(usecase.signIn({ email: address, password: "Wr0ng!pass" })).rejects.toMatchObject(
        { code: "AUTH_INVALID_CREDENTIALS" },
      );
    }
    expect((await credentialRepo.findByEmail(address))?.failedAttempts).toBe(4);

    await expect(usecase.signIn({ email: address, password: "Wr0ng!pass" })).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_LOCKED",
    });

    // The RIGHT password is refused while the lock holds — that is the point.
    await expect(usecase.signIn({ email: address, password: PASSWORD })).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_LOCKED",
    });

    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    await expect(usecase.signIn({ email: address, password: PASSWORD })).resolves.toMatchObject({
      sessionEmail: address,
    });
    // A successful sign-in clears the counter AND the stale lock.
    const cleared = await credentialRepo.findByEmail(address);
    expect(cleared?.failedAttempts).toBe(0);
    expect(cleared?.lockedUntil).toBeNull();
  });

  it("an admin reset replaces the hash, lifts the lock and is audited", async () => {
    const address = email("reset-me");
    const target = await usecase.register({ email: address, password: PASSWORD });

    // A real platform super_admin, minted through the ordinary provisioning path.
    const admin = await accountRepo.provisionAccount({
      provider: "google",
      providerAccountId: `admin-${suffix}`,
      sessionEmail: email("admin"),
      email: email("admin"),
      displayName: "Platform Admin",
    });
    await handle.db
      .update(accounts)
      .set({ platformRole: "super_admin" })
      .where(eq(accounts.id, admin.accountId));

    // Lock the target first, so the reset has something to lift.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await usecase.signIn({ email: address, password: "Wr0ng!pass" }).catch(() => {});
    }
    expect((await credentialRepo.findByEmail(address))?.lockedUntil).not.toBeNull();

    await usecase.setPassword({
      actorAccountId: admin.accountId,
      targetAccountId: target.accountId,
      newPassword: NEW_PASSWORD,
    });

    const after = await credentialRepo.findByEmail(address);
    expect(after?.failedAttempts).toBe(0);
    expect(after?.lockedUntil).toBeNull();

    await expect(usecase.signIn({ email: address, password: NEW_PASSWORD })).resolves.toMatchObject({
      accountId: target.accountId,
    });
    await expect(usecase.signIn({ email: address, password: PASSWORD })).rejects.toMatchObject({
      code: "AUTH_INVALID_CREDENTIALS",
    });

    const audit = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, target.accountId));
    const reset = audit.find((row) => row.action === "auth.password_reset_by_admin");
    expect(reset?.payload).toMatchObject({
      actor_account_id: admin.accountId,
      reason: "PLATFORM_ADMIN_RESET",
      lock_cleared: true,
    });
  });

  it("refuses a reset ordered by an account that is not a platform super_admin", async () => {
    const address = email("safe");
    const target = await usecase.register({ email: address, password: PASSWORD });
    const plain = await accountRepo.provisionAccount({
      provider: "google",
      providerAccountId: `plain-${suffix}`,
      sessionEmail: email("plain"),
      email: email("plain"),
      displayName: "Ordinary Operator",
    });

    await expect(
      usecase.setPassword({
        actorAccountId: plain.accountId,
        targetAccountId: target.accountId,
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // And the old password still works — nothing was half-applied.
    await expect(usecase.signIn({ email: address, password: PASSWORD })).resolves.toBeTruthy();
  });
});
