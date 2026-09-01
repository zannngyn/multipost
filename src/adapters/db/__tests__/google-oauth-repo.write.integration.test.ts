import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { GOOGLE_PROVIDER } from "../catalog-config-repo.drizzle";
import { makeDbHandle } from "../client";
import { DrizzleGoogleOAuthRepo } from "../google-oauth-repo.drizzle";
import { auditLogs, tenantIntegrations, tenants } from "../schema";
import { makeSecretBox } from "../secret-box";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The WRITE path of the Google connection — everything that runs inside a
 * transaction behind the advisory lock, which a stubbed query builder cannot
 * honestly fake: `saveConnection`, `deleteConnection`, `saveSourceAccess`.
 *
 * What it is really pinning down: this repo shares ONE `tenant_integration` row
 * with the Drive folder / spreadsheet / tab settings. Every write here must keep
 * the other keys of that blob — connecting Google must not wipe the source, and
 * disconnecting must not wipe it either.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/google-oauth-repo.write.integration.test.ts
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

/** 32 bytes, base64. Test-only key. */
const TEST_KEY = Buffer.alloc(32, 5).toString("base64");

describe.skipIf(!url)("DrizzleGoogleOAuthRepo — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const lines: LogLine[] = [];
  const box = makeSecretBox({ logger: recordingLogger(lines), readKey: () => TEST_KEY });
  const repo = new DrizzleGoogleOAuthRepo(handle.db, { box, logger: recordingLogger(lines) });
  const tenantId = testTenantId(randomUUID());

  const readRow = async () => {
    const rows = await handle.db
      .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId));
    return rows[0] ?? null;
  };

  const connect = () =>
    repo.saveConnection({
      tenantId,
      refreshToken: "refresh-token-value",
      email: "shop@gmail.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      connectedAt: "2026-08-19T03:00:00.000Z",
      actorUserId: null,
      actorEmail: "operator@example.com",
    });

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E2 google oauth ${tenantId}`, status: "active" });
  });

  beforeEach(async () => {
    lines.length = 0;
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    // The source coordinates exist BEFORE the connection: that is the ordering
    // in which a real tenant gets here, and the one that can lose data.
    await handle.db.insert(tenantIntegrations).values({
      tenantId,
      provider: GOOGLE_PROVIDER,
      status: "active",
      config: { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Mẫu 2026" },
    });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("seals the refresh token and keeps the source coordinates", async () => {
    await connect();

    const row = await readRow();
    const config = row?.config as Record<string, Record<string, unknown>>;
    expect(config.driveFolderId).toBe("folder-1");
    expect(config.sheetName).toBe("Mẫu 2026");
    // Sealed, never plaintext — and readable back through the box.
    expect(String(config.oauth.refreshToken)).not.toContain("refresh-token-value");
    expect(String(config.oauth.refreshToken).startsWith("enc:v1:")).toBe(true);
    await expect(repo.findRefreshToken(tenantId)).resolves.toBe("refresh-token-value");
  });

  it("never stores a Google token as-is because it LOOKS like an envelope", async () => {
    // The input comes from Google, so its shape must not decide whether we
    // encrypt (technical rule 2). The secret box refuses to double-seal, so the
    // connect fails loudly here — which is the point: nothing lands in the row
    // unencrypted.
    await expect(
      repo.saveConnection({
        tenantId,
        refreshToken: "enc:v1:not-really-an-envelope",
        email: "shop@gmail.com",
        scopes: [],
        connectedAt: "2026-08-19T03:00:00.000Z",
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "ALREADY_SEALED" } });

    const config = (await readRow())?.config as Record<string, unknown>;
    expect(config.oauth).toBeUndefined();
  });

  it("revives a row parked in `error` and writes the audit row in the same transaction", async () => {
    await handle.db
      .update(tenantIntegrations)
      .set({ status: "error" })
      .where(eq(tenantIntegrations.tenantId, tenantId));

    await connect();

    expect((await readRow())?.status).toBe("active");
    const audit = await handle.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(audit.map((entry) => entry.action)).toContain("google_oauth.connected");
  });

  it("stores the source-access verdict without touching the token or the source", async () => {
    await connect();

    await repo.saveSourceAccess({
      tenantId,
      state: "drive_unreadable",
      checkedAt: "2026-08-19T04:00:00.000Z",
    });

    const config = (await readRow())?.config as Record<string, Record<string, unknown>>;
    expect(config.oauth.sourceAccess).toEqual({
      state: "drive_unreadable",
      checkedAt: "2026-08-19T04:00:00.000Z",
    });
    expect(config.driveFolderId).toBe("folder-1");
    await expect(repo.findRefreshToken(tenantId)).resolves.toBe("refresh-token-value");
    await expect(repo.findConnection(tenantId)).resolves.toMatchObject({
      sourceAccess: { state: "drive_unreadable" },
    });
  });

  it("writes NO verdict for a tenant that never connected — that screen has nothing to fix", async () => {
    await repo.saveSourceAccess({
      tenantId,
      state: "drive_unreadable",
      checkedAt: "2026-08-19T04:00:00.000Z",
    });

    const config = (await readRow())?.config as Record<string, unknown>;
    expect(config.oauth).toBeUndefined();
  });

  it("removes only the oauth key on disconnect, and is idempotent", async () => {
    await connect();

    await expect(
      repo.deleteConnection({ tenantId, actorUserId: null, actorEmail: "operator@example.com" }),
    ).resolves.toEqual({ removed: true });

    const row = await readRow();
    const config = row?.config as Record<string, unknown>;
    expect(config.oauth).toBeUndefined();
    expect(config.driveFolderId).toBe("folder-1");
    expect(row?.status).toBe("active");

    // Pressing "Ngắt kết nối" twice must land in the same state.
    await expect(
      repo.deleteConnection({ tenantId, actorUserId: null, actorEmail: null }),
    ).resolves.toEqual({ removed: false });
  });

  it("clears the `error` marker on disconnect but keeps an administrative `disabled`", async () => {
    await connect();
    await handle.db
      .update(tenantIntegrations)
      .set({ status: "disabled" })
      .where(eq(tenantIntegrations.tenantId, tenantId));

    await repo.deleteConnection({ tenantId, actorUserId: null, actorEmail: null });

    expect((await readRow())?.status).toBe("disabled");
  });

  it("parks a live connection in `error`, and leaves a disconnected tenant alone", async () => {
    await connect();
    await repo.markConnectionExpired(tenantId, "REFRESH_REJECTED");
    expect((await readRow())?.status).toBe("error");

    await repo.deleteConnection({ tenantId, actorUserId: null, actorEmail: null });
    expect((await readRow())?.status).toBe("active");

    // No blob any more: the second call must not flag the row again.
    await repo.markConnectionExpired(tenantId, "REFRESH_REJECTED");
    expect((await readRow())?.status).toBe("active");
  });
});
