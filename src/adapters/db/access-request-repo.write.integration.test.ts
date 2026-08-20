import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OperatorIdentity } from "@/core/domain/access-request";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { DrizzleAccessRequestRepo } from "./access-request-repo.drizzle";
import { makeDbHandle } from "./client";
import { accessRequests, accounts, auditLogs, identities, tenants, users } from "./schema";
import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The WRITE path of the access registry — the parts a stubbed query builder
 * cannot honestly fake:
 *   - the idempotent upsert on (tenant, provider, provider_account_id);
 *   - `decide` writing registry row + `app_user` + `audit_log` in ONE
 *     transaction (an approval nobody can trace is the failure that matters);
 *   - the unique index on (tenant, session_email), which is what stops two
 *     identities resolving to one session.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/access-request-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

/**
 * Unique per run: since M1.2, `decide()` writes GLOBAL `account`/`identity`
 * rows, and a fixed id here would collide with other test files (and with the
 * real bootstrap admin id) on the shared database.
 */
const RUN_FB_ID = `9927${Date.now()}${Math.floor(Math.random() * 1000)}`;

const facebookIdentity: OperatorIdentity = {
  provider: "facebook",
  providerAccountId: RUN_FB_ID,
  sessionEmail: `fb-${RUN_FB_ID}@facebook.local`,
  // Facebook may return none — the column must accept it.
  email: null,
  displayName: "Nguyen Van A",
};

describe.skipIf(!url)("DrizzleAccessRequestRepo — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const lines: LogLine[] = [];
  const repo = new DrizzleAccessRequestRepo(handle.db, { logger: recordingLogger(lines) });
  const tenantId = testTenantId(randomUUID());

  /** Every session address this file ever writes — the cleanup key. */
  const RUN_EMAILS = [
    facebookIdentity.sessionEmail,
    "a@gmail.com",
    "shared@example.org",
    "later@gmail.com",
  ];

  const clean = async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(accessRequests).where(eq(accessRequests.tenantId, tenantId));
    await handle.db.delete(users).where(eq(users.tenantId, tenantId));
    // M1.2: decide() provisions GLOBAL account/identity rows — leaving them
    // behind poisons the backfill test, which replays migration SQL against
    // whatever this table holds. Deleting the accounts cascades to identities
    // and memberships.
    const minted = await handle.db
      .select({ accountId: identities.accountId })
      .from(identities)
      .where(inArray(identities.sessionEmail, RUN_EMAILS));
    if (minted.length > 0) {
      await handle.db
        .delete(accounts)
        .where(inArray(accounts.id, [...new Set(minted.map((row) => row.accountId))]));
    }
  };

  // decide() writes GLOBAL identity rows since M1.2 — serialise against the
  // backfill test, which replays migration SQL over the whole registry table.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");

  beforeAll(async () => {
    await globalLock.acquire();
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E1.4 access ${tenantId}`, status: "active" });
  });

  beforeEach(async () => {
    lines.length = 0;
    await clean();
  });

  afterAll(async () => {
    await clean();
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await globalLock.release();
    await handle.close();
  });

  it("records a first sign-in with no e-mail as pending", async () => {
    const created = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date("2026-08-19T03:00:00.000Z"),
    });

    expect(created.status).toBe("pending");
    expect(created.email).toBeNull();
    expect(created.role).toBeNull();
    expect(await repo.findBySessionEmail(tenantId, facebookIdentity.sessionEmail)).toMatchObject({
      id: created.id,
    });
  });

  it("is idempotent: a second first-sign-in returns the same row, not a duplicate key", async () => {
    const first = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date(),
    });
    const second = await repo.createPending({
      tenantId,
      identity: { ...facebookIdentity, displayName: "Nguyen Van A (updated)" },
      requestedAt: new Date(),
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Nguyen Van A (updated)");
    expect(await repo.list(tenantId, "all")).toHaveLength(1);
  });

  it("never resets a decision when the identity signs in again", async () => {
    const created = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date(),
    });
    await repo.decide({
      tenantId,
      id: created.id,
      status: "blocked",
      role: null,
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: "boss@mysp.vn",
    });

    const again = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date(),
    });

    expect(again.status).toBe("blocked");
  });

  it("keeps the same provider id under two providers as two identities", async () => {
    await repo.createPending({ tenantId, identity: facebookIdentity, requestedAt: new Date() });
    await repo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "992710700450296",
        sessionEmail: "a@gmail.com",
        email: "a@gmail.com",
        displayName: "A",
      },
      requestedAt: new Date(),
    });

    expect(await repo.list(tenantId, "all")).toHaveLength(2);
  });

  it("approving creates the app_user row and the audit entry in one go", async () => {
    const created = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date(),
    });

    const decided = await repo.decide({
      tenantId,
      id: created.id,
      status: "approved",
      role: "editor",
      decidedAt: new Date("2026-08-19T06:00:00.000Z"),
      decidedByUserId: null,
      decidedByEmail: "boss@mysp.vn",
    });

    expect(decided).toMatchObject({ status: "approved", role: "editor" });

    const operators = await handle.db.select().from(users).where(eq(users.tenantId, tenantId));
    expect(operators).toHaveLength(1);
    expect(operators[0]).toMatchObject({
      email: facebookIdentity.sessionEmail,
      role: "editor",
    });

    const trail = await handle.db
      .select({ action: auditLogs.action, payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe("access_request.approved");
    expect(trail[0].payload).toMatchObject({
      provider: "facebook",
      previous_status: "pending",
      new_status: "approved",
      role: "editor",
      actor_email: "boss@mysp.vn",
    });
  });

  it("blocking leaves a trail and keeps the app_user row (drafts and audit reference it)", async () => {
    const created = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date(),
    });
    await repo.decide({
      tenantId,
      id: created.id,
      status: "approved",
      role: "editor",
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: "boss@mysp.vn",
    });

    const blocked = await repo.decide({
      tenantId,
      id: created.id,
      status: "blocked",
      role: null,
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: "boss@mysp.vn",
    });

    expect(blocked?.status).toBe("blocked");
    expect(await handle.db.select().from(users).where(eq(users.tenantId, tenantId))).toHaveLength(1);

    const actions = await handle.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(actions.map((row) => row.action)).toEqual([
      "access_request.approved",
      "access_request.blocked",
    ]);
  });

  it("answers null for an id this tenant does not own, and writes nothing", async () => {
    const missing = await repo.decide({
      tenantId,
      id: randomUUID(),
      status: "blocked",
      role: null,
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: null,
    });

    expect(missing).toBeNull();
    expect(await handle.db.select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId))).toHaveLength(0);
  });

  it("refuses a second identity that would sign in under an address already taken", async () => {
    await repo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "sub-1",
        sessionEmail: "shared@example.org",
        email: "shared@example.org",
        displayName: "First",
      },
      requestedAt: new Date(),
    });

    // Same address, different identity: INVALID_INPUT (a caller problem), never
    // a 503 that tells the operator to retry something retrying cannot fix.
    await expect(
      repo.createPending({
        tenantId,
        identity: {
          provider: "google",
          providerAccountId: "sub-2",
          sessionEmail: "shared@example.org",
          email: "shared@example.org",
          displayName: "Second",
        },
        requestedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("turns a malformed id into INVALID_INPUT, not a database outage", async () => {
    await expect(
      repo.decide({
        tenantId,
        id: "not-a-uuid",
        status: "blocked",
        role: null,
        decidedAt: new Date(),
        decidedByUserId: null,
        decidedByEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("lists newest first and filters by status", async () => {
    const first = await repo.createPending({
      tenantId,
      identity: facebookIdentity,
      requestedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    await repo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "sub-2",
        sessionEmail: "later@gmail.com",
        email: "later@gmail.com",
        displayName: null,
      },
      requestedAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    await repo.decide({
      tenantId,
      id: first.id,
      status: "approved",
      role: "viewer",
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: null,
    });

    const pending = await repo.list(tenantId, "pending");
    expect(pending.map((row) => row.sessionEmail)).toEqual(["later@gmail.com"]);

    const all = await repo.list(tenantId, "all");
    expect(all.map((row) => row.sessionEmail)).toEqual([
      "later@gmail.com",
      facebookIdentity.sessionEmail,
    ]);
  });
});
