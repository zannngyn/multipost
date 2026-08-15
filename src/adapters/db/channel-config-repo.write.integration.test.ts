import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { channelConfigLockKey, DrizzleChannelConfigRepo } from "./channel-config-repo.drizzle";
import { makeDbHandle } from "./client";
import { auditLogs, tenantIntegrations, tenants } from "./schema";
import { makeSecretBox } from "./secret-box";

/**
 * The E5.1 WRITE path against a REAL Postgres: the transaction, the jsonb
 * read-modify-write, the unique (tenant_id, provider) upsert and the audit row
 * are exactly the parts a stubbed query builder proves nothing about.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database, so `pnpm
 * verify` stays green on a machine without Docker:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/channel-config-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;
/** 32 bytes, base64. Test-only key. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

const lines: LogLine[] = [];

function recordingLogger(): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

describe.skipIf(!url)("DrizzleChannelConfigRepo — write path (real database)", () => {
  // >= 3: the concurrency test holds one connection open while the repo works.
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 5 });
  const logger = recordingLogger();
  const box = makeSecretBox({ logger, readKey: () => TEST_KEY });
  const repo = new DrizzleChannelConfigRepo(handle.db, { box, logger });
  const tenantId = randomUUID();

  /** The status COLUMN of the provider row (not the per-channel status). */
  async function integrationStatus(): Promise<string> {
    const [row] = await handle.db
      .select({ status: tenantIntegrations.status })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId));
    return row.status;
  }

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E5.1 write test ${tenantId}`, status: "active" });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  // --- Edge cases first -----------------------------------------------------

  it("refuses an empty channel list instead of writing nothing quietly", async () => {
    await expect(repo.upsertChannels({ tenantId, channels: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "EMPTY" },
    });
  });

  it("refuses a channel without a token, naming the FIELD and not the value", async () => {
    const error = await repo
      .upsertChannels({
        tenantId,
        channels: [
          {
            channelId: "fb-broken",
            platform: "facebook",
            name: "Shop",
            externalId: "1",
            accessToken: "",
            tokenExpiresAt: null,
          },
        ],
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect((error as AppError).context).toMatchObject({ missing: ["accessToken"] });
  });

  it("answers null for a channel that does not exist (no silent insert)", async () => {
    expect(
      await repo.setChannelStatus({ tenantId, channelId: "fb-nope", status: "disabled" }),
    ).toBeNull();
    expect(await repo.removeChannel({ tenantId, channelId: "fb-nope" })).toBe(false);
  });

  // --- Happy path -----------------------------------------------------------

  it("creates the provider row on the first import, with sealed tokens", async () => {
    const result = await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-111",
          platform: "facebook",
          name: "Shop A",
          externalId: "111",
          accessToken: "page-token-a",
          tokenExpiresAt: null,
        },
        {
          channelId: "fb-222",
          platform: "facebook",
          name: "Shop B",
          externalId: "222",
          accessToken: "page-token-b",
          tokenExpiresAt: null,
        },
      ],
      userAccessToken: "user-token-1",
      actorEmail: "operator@example.com",
    });

    expect(result).toEqual({ added: ["fb-111", "fb-222"], updated: [] });

    // What is IN the row is an envelope, not a token.
    const [row] = await handle.db
      .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId));
    const stored = JSON.stringify(row.config);
    expect(stored).not.toContain("page-token-a");
    expect(stored).not.toContain("user-token-1");
    expect(stored).toContain("enc:v1:");
    expect(row.status).toBe("active");

    // What the publisher reads back IS the token.
    const channels = await repo.listChannels(tenantId);
    expect(channels.map((channel) => channel.channelId)).toEqual(["fb-111", "fb-222"]);
    expect(channels[0]).toMatchObject({ accessToken: "page-token-a", status: "active" });
    expect(await repo.findUserAccessToken(tenantId)).toBe("user-token-1");
  });

  it("writes ONE audit row per import, with ids only", async () => {
    const rows = await handle.db
      .select({ action: auditLogs.action, payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));

    const imported = rows.filter((row) => row.action === "channel.imported");
    expect(imported).toHaveLength(1);
    expect(imported[0].payload).toMatchObject({
      added: ["fb-111", "fb-222"],
      updated: [],
      actor_email: "operator@example.com",
    });
    expect(JSON.stringify(imported[0].payload)).not.toContain("page-token");
  });

  it("keeps the status of a channel the operator switched OFF across a re-import", async () => {
    await repo.setChannelStatus({ tenantId, channelId: "fb-222", status: "disabled" });

    const result = await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-222",
          platform: "facebook",
          name: "Shop B (đổi tên)",
          externalId: "222",
          accessToken: "page-token-b2",
          tokenExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          channelId: "fb-333",
          platform: "facebook",
          name: "Shop C",
          externalId: "333",
          accessToken: "page-token-c",
          tokenExpiresAt: null,
        },
      ],
    });

    expect(result).toEqual({ added: ["fb-333"], updated: ["fb-222"] });

    const channels = await repo.listChannels(tenantId);
    const b = channels.find((channel) => channel.channelId === "fb-222");
    expect(b).toMatchObject({
      name: "Shop B (đổi tên)",
      accessToken: "page-token-b2",
      // Refreshed, but NOT switched back on.
      status: "disabled",
    });
    expect(b?.tokenExpiresAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // A channel the platform did not list this time is left untouched.
    expect(channels.find((channel) => channel.channelId === "fb-111")?.status).toBe("active");
    // And the stored user token survives an import that does not carry one.
    expect(await repo.findUserAccessToken(tenantId)).toBe("user-token-1");
  });

  it("removes one channel and leaves the others alone", async () => {
    expect(await repo.removeChannel({ tenantId, channelId: "fb-333" })).toBe(true);

    const channels = await repo.listChannels(tenantId);
    expect(channels.map((channel) => channel.channelId)).toEqual(["fb-111", "fb-222"]);
    expect(channels[0].accessToken).toBe("page-token-a");
  });

  it("does NOT revive an integration in `error` when a channel is only switched off or removed", async () => {
    // A throwaway channel to delete later. Added first, because an IMPORT is
    // exactly the write that is allowed to clear the `error` marker.
    await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-444",
          platform: "facebook",
          name: "Shop D",
          externalId: "444",
          accessToken: "page-token-d",
          tokenExpiresAt: null,
        },
      ],
    });
    await handle.db
      .update(tenantIntegrations)
      .set({ status: "error" })
      .where(eq(tenantIntegrations.tenantId, tenantId));

    await repo.setChannelStatus({ tenantId, channelId: "fb-222", status: "disabled" });
    expect(await integrationStatus()).toBe("error");

    expect(await repo.removeChannel({ tenantId, channelId: "fb-444" })).toBe(true);
    // Still `error`: nobody proved the token works again.
    expect(await integrationStatus()).toBe("error");

    await handle.db
      .update(tenantIntegrations)
      .set({ status: "active" })
      .where(eq(tenantIntegrations.tenantId, tenantId));
  });

  it("re-activates an integration parked in `error` after a successful import", async () => {
    await handle.db
      .update(tenantIntegrations)
      .set({ status: "error" })
      .where(eq(tenantIntegrations.tenantId, tenantId));

    await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-111",
          platform: "facebook",
          name: "Shop A",
          externalId: "111",
          accessToken: "page-token-a3",
          tokenExpiresAt: null,
        },
      ],
    });

    const [row] = await handle.db
      .select({ status: tenantIntegrations.status })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId));
    expect(row.status).toBe("active");
  });

  it("keeps the tenant's spacing/retry knobs across an import", async () => {
    // Tuned by hand (or by a future settings screen) — an import must not reset
    // them to the defaults.
    await handle.db
      .update(tenantIntegrations)
      .set({
        config: sql`jsonb_set(jsonb_set(${tenantIntegrations.config}, '{spacingMs}', '120000'), '{maxAttempts}', '2')`,
      })
      .where(eq(tenantIntegrations.tenantId, tenantId));

    await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-111",
          platform: "facebook",
          name: "Shop A",
          externalId: "111",
          accessToken: "page-token-a4",
          tokenExpiresAt: null,
        },
      ],
    });

    expect(await repo.getPublishSettings(tenantId)).toMatchObject({
      spacingMs: 120_000,
      maxAttempts: 2,
    });
  });

  it("leaves the TikTok provider row alone (E6 lives in its own row)", async () => {
    const tiktokConfig = {
      channels: [
        {
          channelId: "tiktok-shop",
          platform: "tiktok",
          name: "Shop TikTok",
          externalId: "open-id-1",
          accessToken: "tiktok-token",
          status: "active",
          tiktok: { privacyLevel: "SELF_ONLY", isAigc: true, openId: "open-id-1" },
        },
      ],
    };
    await handle.db
      .insert(tenantIntegrations)
      .values({ tenantId, provider: "tiktok", status: "active", config: tiktokConfig });

    await repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-111",
          platform: "facebook",
          name: "Shop A",
          externalId: "111",
          accessToken: "page-token-a5",
          tokenExpiresAt: null,
        },
      ],
    });

    const [row] = await handle.db
      .select({ config: tenantIntegrations.config })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.provider, "tiktok"));
    expect(row.config).toEqual(tiktokConfig);

    // ...and both platforms still show up as one flat list for the caller.
    const channels = await repo.listChannels(tenantId);
    expect(channels.map((channel) => channel.channelId).sort()).toEqual([
      "fb-111",
      "fb-222",
      "tiktok-shop",
    ]);

    await handle.db
      .delete(tenantIntegrations)
      .where(eq(tenantIntegrations.provider, "tiktok"));
  });

  it("never leaked a token into a log line", () => {
    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain("page-token");
    expect(serialised).not.toContain("user-token-1");
  });
});

/**
 * The FIRST import of a tenant, run twice at the same moment. This is the case
 * `SELECT ... FOR UPDATE` alone cannot cover: with no row to lock, both writers
 * read an empty config and the second `ON CONFLICT DO UPDATE` overwrites the
 * first one's Pages while both answer "đã kết nối".
 *
 * The interleaving is FORCED, not hoped for: a separate transaction takes the
 * repo's own advisory lock, inserts the competing row, and is only committed
 * after the repo call has been given time to reach its own read. Without the
 * advisory lock in readForUpdate this test fails with `channels: ["fb-A"]`.
 */
describe.skipIf(!url)("DrizzleChannelConfigRepo — two first imports at once", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 5 });
  const logger = recordingLogger();
  const box = makeSecretBox({ logger, readKey: () => TEST_KEY });
  const repo = new DrizzleChannelConfigRepo(handle.db, { box, logger });
  const tenantId = randomUUID();

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E5.1 race test ${tenantId}`, status: "active" });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("does not lose the Pages of the writer that got there first", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Writer B: holds the same lock the repo takes, writes its Page, waits.
    const writerB = handle.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${channelConfigLockKey(tenantId)}))`);
      await tx.insert(tenantIntegrations).values({
        tenantId,
        provider: "meta",
        status: "active",
        config: {
          spacingMs: 60_000,
          retryBackoffMs: 60_000,
          maxAttempts: 3,
          channels: [
            {
              channelId: "fb-B",
              platform: "facebook",
              name: "Shop B",
              externalId: "B",
              accessToken: "page-token-b",
              status: "active",
            },
          ],
        },
      });
      await held;
    });

    // Writer A: the repo, arriving while B still holds the lock.
    const writerA = repo.upsertChannels({
      tenantId,
      channels: [
        {
          channelId: "fb-A",
          platform: "facebook",
          name: "Shop A",
          externalId: "A",
          accessToken: "page-token-a",
          tokenExpiresAt: null,
        },
      ],
    });

    // Long enough for A to have read the (empty) config if it were not blocked.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await writerB;
    const result = await writerA;

    // A only saw the row AFTER B committed, so it merged instead of replacing.
    expect(result).toEqual({ added: ["fb-A"], updated: [] });
    const channels = await repo.listChannels(tenantId);
    expect(channels.map((channel) => channel.channelId).sort()).toEqual(["fb-A", "fb-B"]);
  });
});
