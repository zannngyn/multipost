import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig, ChannelConfigRepo } from "@/core/ports/publisher";

import { makeManageChannels, toChannelView } from "./manage-channels";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E5.1 — the channel list screen: read, switch on/off, remove. */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function channel(channelId: string, status: ChannelConfig["status"] = "active"): ChannelConfig {
  return {
    channelId,
    platform: "facebook",
    name: `Tên ${channelId}`,
    externalId: channelId.replace("fb-", ""),
    accessToken: "page-token-secret",
    status,
    tokenExpiresAt: null,
  };
}

function harness(seed: ChannelConfig[] = [channel("fb-111")]) {
  const store = new Map(seed.map((entry) => [entry.channelId, entry]));
  const channels: ChannelConfigRepo = {
    findChannel: async (_tenantId, channelId) => store.get(channelId) ?? null,
    listChannels: async () => [...store.values()],
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 0, maxAttempts: 3 }),
    upsertChannels: async () => {
      throw new AppError("INTERNAL", { message: "unused here" });
    },
    findUserAccessToken: async () => null,
    setChannelStatus: async ({ channelId, status }) => {
      const current = store.get(channelId);
      if (!current) return null;
      const next = { ...current, status };
      store.set(channelId, next);
      return next;
    },
    removeChannel: async ({ channelId }) => store.delete(channelId),
  };
  return { usecases: makeManageChannels({ channels, logger: silentLogger() }), store };
}

// --- Edge cases first -------------------------------------------------------

describe("manage channels — refusals", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    const { usecases } = harness();
    await expect(usecases.listChannels({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses a status that is neither active nor disabled", async () => {
    const { usecases } = harness();
    await expect(
      usecases.setChannelStatus({
        tenantId: TENANT,
        channelId: "fb-111",
        status: "paused" as "active",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "status" } });
  });

  it("reports a channel this tenant does not have, for both writes", async () => {
    const { usecases } = harness();
    await expect(
      usecases.setChannelStatus({ tenantId: TENANT, channelId: "fb-999", status: "disabled" }),
    ).rejects.toMatchObject({
      code: "CHANNEL_NOT_CONFIGURED",
      context: { reason: "CHANNEL_NOT_FOUND" },
    });
    await expect(
      usecases.removeChannel({ tenantId: TENANT, channelId: "fb-999" }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
  });
});

// --- Happy paths ------------------------------------------------------------

describe("manage channels — the list never carries a credential", () => {
  it("strips accessToken from the view (allowlist on the way out)", () => {
    const view = toChannelView(channel("fb-111"));
    expect(view).toEqual({
      channelId: "fb-111",
      platform: "facebook",
      name: "Tên fb-111",
      externalId: "111",
      status: "active",
      tokenExpiresAt: null,
    });
    expect(JSON.stringify(view)).not.toContain("page-token-secret");
  });

  it("answers an empty list for a tenant nobody connected yet", async () => {
    const { usecases } = harness([]);
    expect(await usecases.listChannels({ tenantId: TENANT })).toEqual([]);
  });

  it("lists real channels WITHOUT their tokens", async () => {
    const { usecases } = harness([channel("fb-111"), channel("fb-222", "disabled")]);

    const list = await usecases.listChannels({ tenantId: TENANT });

    expect(list.map((entry) => entry.channelId)).toEqual(["fb-111", "fb-222"]);
    expect(list.map((entry) => entry.status)).toEqual(["active", "disabled"]);
    // The repo hands the usecase a token; the usecase must not hand it on.
    for (const entry of list) expect(entry).not.toHaveProperty("accessToken");
    expect(JSON.stringify(list)).not.toContain("page-token-secret");
  });

  it("returns the switched channel without its token either", async () => {
    const { usecases } = harness();

    const updated = await usecases.setChannelStatus({
      tenantId: TENANT,
      channelId: "fb-111",
      status: "disabled",
    });

    expect(updated).not.toHaveProperty("accessToken");
    expect(JSON.stringify(updated)).not.toContain("page-token-secret");
  });

  it("switches a channel off, then removes it", async () => {
    const { usecases, store } = harness();

    const off = await usecases.setChannelStatus({
      tenantId: TENANT,
      channelId: "fb-111",
      status: "disabled",
    });
    expect(off).toMatchObject({ channelId: "fb-111", status: "disabled" });
    expect(store.get("fb-111")?.status).toBe("disabled");

    expect(await usecases.removeChannel({ tenantId: TENANT, channelId: "fb-111" })).toEqual({
      channelId: "fb-111",
      removed: true,
    });
    expect(store.size).toBe(0);
  });
});
