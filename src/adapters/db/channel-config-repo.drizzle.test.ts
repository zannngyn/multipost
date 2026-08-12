import { describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { DrizzleChannelConfigRepo, sealMetaConfig } from "./channel-config-repo.drizzle";
import type { Database } from "./client";
import { makeSecretBox } from "./secret-box";

/**
 * The credential path of tenant_integration (meta), without a database: the
 * query builder is stubbed, the SECRET BOX is real — encryption is exactly the
 * part a fake would make meaningless.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
/** 32 zero bytes, base64. Test-only key. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

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

/** Minimal stand-in for the drizzle chain the repo uses. */
function stubDb(rows: Array<{ config: Record<string, unknown>; status: string }>): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  } as unknown as Database;
}

function channelConfig(accessToken: string) {
  return {
    spacingMs: 1_000,
    retryBackoffMs: 500,
    maxAttempts: 3,
    channels: [
      {
        channelId: "fbpage-a",
        platform: "facebook",
        name: "Shop A",
        externalId: "100000000000001",
        accessToken,
        status: "active",
      },
    ],
  };
}

function harness(config: Record<string, unknown>, status = "active", key: string = TEST_KEY) {
  const lines: LogLine[] = [];
  const logger = recordingLogger(lines);
  const box = makeSecretBox({ logger, readKey: () => key });
  const repo = new DrizzleChannelConfigRepo(stubDb([{ config, status }]), { box, logger });
  return { repo, box, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("DrizzleChannelConfigRepo — secrets", () => {
  it("refuses to publish with a config it cannot decrypt (wrong key)", async () => {
    const other = makeSecretBox({
      logger: recordingLogger([]),
      readKey: () => Buffer.alloc(32, 9).toString("base64"),
    });
    const sealed = sealMetaConfig(channelConfig("page-token-a"), other);
    const { repo } = harness(sealed as unknown as Record<string, unknown>);

    await expect(repo.listChannels(TENANT)).rejects.toMatchObject({
      code: "CHANNEL_NOT_CONFIGURED",
      context: { reason: "SECRET_UNREADABLE" },
    });
  });

  it("rejects a malformed config instead of publishing half a configuration", async () => {
    const { repo } = harness({ channels: [{ channelId: "fbpage-a" }] });
    await expect(repo.listChannels(TENANT)).rejects.toMatchObject({
      code: "CHANNEL_NOT_CONFIGURED",
    });
  });
});

describe("DrizzleChannelConfigRepo — sealed tokens", () => {
  it("stores an envelope but hands the publisher the real token", async () => {
    const { repo, box, lines } = harness({});
    const sealed = sealMetaConfig(channelConfig("page-token-a"), box) as unknown as Record<
      string,
      unknown
    >;

    // What sits in the row is NOT the token.
    const storedToken = (sealed.channels as Array<{ accessToken: string }>)[0].accessToken;
    expect(storedToken).toMatch(/^enc:v1:/);
    expect(storedToken).not.toContain("page-token-a");

    const { repo: reader } = harness(sealed);
    const channels = await reader.listChannels(TENANT);
    expect(channels[0]).toMatchObject({ channelId: "fbpage-a", accessToken: "page-token-a" });
    // No legacy warning for a properly sealed row.
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(0);
    expect(await repo.listChannels(TENANT)).toEqual([]);
  });

  it("is idempotent: re-sealing an already sealed config changes nothing", async () => {
    const { box } = harness({});
    const once = sealMetaConfig(channelConfig("page-token-a"), box);
    const twice = sealMetaConfig(once, box);
    expect(twice).toEqual(once);
  });

  it("still reads a legacy PLAINTEXT token, and says so", async () => {
    const { repo, lines } = harness(channelConfig("plain-legacy-token") as unknown as Record<string, unknown>);

    const channels = await repo.listChannels(TENANT);

    expect(channels[0].accessToken).toBe("plain-legacy-token");
    const warns = lines.filter((line) => line.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    // Field PATHS only — a warning that leaks the token defeats its purpose.
    const serialised = JSON.stringify(warns);
    expect(serialised).toContain("PLAINTEXT_LEGACY");
    expect(serialised).toContain("accessToken");
    expect(serialised).not.toContain("plain-legacy-token");
  });

  it("opens the token before the schema check (an envelope is still non-empty)", async () => {
    const { box } = harness({});
    const sealed = sealMetaConfig(channelConfig("page-token-a"), box) as unknown as Record<
      string,
      unknown
    >;
    const { repo } = harness(sealed);
    const settings = await repo.getPublishSettings(TENANT);
    expect(settings).toEqual({ spacingMs: 1_000, retryBackoffMs: 500, maxAttempts: 3 });
  });

  it("marks every channel disabled when the integration row is disabled", async () => {
    const { box } = harness({});
    const sealed = sealMetaConfig(channelConfig("page-token-a"), box) as unknown as Record<
      string,
      unknown
    >;
    const { repo } = harness(sealed, "disabled");
    const channels = await repo.listChannels(TENANT);
    expect(channels[0].status).toBe("disabled");
  });
});
