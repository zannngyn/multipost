import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeDbHandle } from "../client";
import { DrizzleOAuthStateStore } from "../oauth-state-store.drizzle";
import { accounts, oauthStates, tenants } from "../schema";

/**
 * M1.3b — the `oauth_state` guarantees a stubbed query builder cannot honestly
 * fake: the SINGLE-USE claim is one atomic UPDATE (two racing callbacks can
 * never both win), expiry is enforced in the same statement, and the purpose
 * is part of the key.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/oauth-state-store.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

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

describe.skipIf(!url)("DrizzleOAuthStateStore — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const store = new DrizzleOAuthStateStore(handle.db, { logger: silentLogger() });

  // Branded once: the schema columns take TenantId since M1.3a.
  const tenantId = testTenantId(randomUUID());
  let accountId = "";
  const NOW = new Date("2026-08-20T04:00:00.000Z");
  const LATER = new Date(NOW.getTime() + 10 * 60 * 1000);

  /** 64-hex like a real sha256; unique per call. */
  const nonceHash = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `M1.3b oauth ${tenantId}`, status: "active" });
    const rows = await handle.db
      .insert(accounts)
      .values({ displayName: "OAuth State Tester" })
      .returning({ id: accounts.id });
    accountId = rows[0].id;
  });

  beforeEach(async () => {
    await handle.db.delete(oauthStates).where(eq(oauthStates.tenantId, tenantId));
  });

  afterAll(async () => {
    await handle.db.delete(oauthStates).where(eq(oauthStates.tenantId, tenantId));
    await handle.db.delete(accounts).where(inArray(accounts.id, [accountId]));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  const issue = (hash: string, expiresAt = LATER) =>
    store.issue({
      nonceHash: hash,
      tenantId,
      accountId,
      purpose: "google_drive",
      expiresAt,
    });

  // --- Edge cases first -------------------------------------------------------

  it("refuses to issue with a hash too short to be a hash", async () => {
    await expect(issue("short")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers null for an unknown nonce — no error, no oracle", async () => {
    await expect(
      store.claim({ nonceHash: nonceHash(), purpose: "google_drive", now: NOW }),
    ).resolves.toBeNull();
  });

  it("answers null for an EXPIRED row", async () => {
    const hash = nonceHash();
    await issue(hash, new Date(NOW.getTime() - 1)); // already past

    await expect(
      store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW }),
    ).resolves.toBeNull();
  });

  it("answers null for the WRONG PURPOSE — a Google nonce cannot finish a Facebook flow", async () => {
    const hash = nonceHash();
    await issue(hash);

    await expect(
      store.claim({ nonceHash: hash, purpose: "facebook_pages", now: NOW }),
    ).resolves.toBeNull();
    // And the row was NOT burned by the wrong-purpose attempt.
    await expect(
      store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW }),
    ).resolves.toMatchObject({ tenantId, accountId });
  });

  // --- The single-use core ----------------------------------------------------

  it("claims exactly once: the second claim of the same nonce gets nothing", async () => {
    const hash = nonceHash();
    await issue(hash);

    const first = await store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW });
    expect(first).toEqual({ tenantId, accountId });

    const second = await store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW });
    expect(second).toBeNull();

    const rows = await handle.db
      .select({ usedAt: oauthStates.usedAt })
      .from(oauthStates)
      .where(eq(oauthStates.nonceHash, hash));
    expect(rows[0].usedAt).toEqual(NOW);
  });

  it("two RACING claims: exactly one wins", async () => {
    const hash = nonceHash();
    await issue(hash);

    const [a, b] = await Promise.all([
      store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW }),
      store.claim({ nonceHash: hash, purpose: "google_drive", now: NOW }),
    ]);

    const winners = [a, b].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
  });

  it("refuses a second issue of the same hash — the unique key holds", async () => {
    const hash = nonceHash();
    await issue(hash);
    await expect(issue(hash)).rejects.toMatchObject({ code: "DB_ERROR" });
  });
});
