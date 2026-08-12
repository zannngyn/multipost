import { describe, expect, it } from "vitest";

import type { ChannelGroup } from "@/core/domain/channel-group";
import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig, ChannelConfigRepo, ChannelGroupRepo } from "@/core/ports/publisher";

import { makeManageChannelGroups } from "./manage-channel-groups";

/**
 * E7.6 — channel presets. The rule that matters: a group can only ever hold
 * channels the tenant really has, otherwise a later fan-out silently drops a post.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-08-13T02:00:00.000Z");

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

function channel(channelId: string): ChannelConfig {
  return {
    channelId,
    platform: "facebook",
    name: channelId,
    externalId: `page-${channelId}`,
    accessToken: "secret",
    status: "active",
    tokenExpiresAt: null,
  };
}

function makeGroupRepo(seed: ChannelGroup[] = []) {
  const store = new Map(seed.map((group) => [group.id, group]));
  const repo: ChannelGroupRepo & { store: typeof store } = {
    store,
    async listGroups() {
      return [...store.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async findGroupById(_tenantId, groupId) {
      return store.get(groupId) ?? null;
    },
    async createGroup(input) {
      for (const existing of store.values()) {
        if (existing.name === input.name) {
          // Mirrors the unique (tenant_id, name) index of the Drizzle repo.
          throw new AppError("INVALID_INPUT", {
            message: "duplicate name",
            context: { reason: "CHANNEL_GROUP_NAME_TAKEN", name: input.name },
          });
        }
      }
      const group: ChannelGroup = {
        id: input.id,
        tenantId: input.tenantId,
        name: input.name,
        channelIds: [...input.channelIds],
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.set(group.id, group);
      return group;
    },
    async updateGroup(input) {
      const current = store.get(input.groupId);
      if (!current) return null;
      const next: ChannelGroup = {
        ...current,
        name: input.name,
        channelIds: [...input.channelIds],
        updatedAt: NOW,
      };
      store.set(next.id, next);
      return next;
    },
    async deleteGroup(_tenantId, groupId) {
      return store.delete(groupId);
    },
  };
  return repo;
}

function harness(options: { channels?: string[]; groups?: ChannelGroup[] } = {}) {
  const known = (options.channels ?? ["fbpage-a", "fbpage-b", "fbpage-c"]).map(channel);
  const channels: ChannelConfigRepo = {
    findChannel: async (_tenantId, channelId) =>
      known.find((entry) => entry.channelId === channelId) ?? null,
    listChannels: async () => known,
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 0, maxAttempts: 3 }),
  };
  const groups = makeGroupRepo(options.groups);
  let counter = 0;
  const usecases = makeManageChannelGroups({
    groups,
    channels,
    logger: silentLogger(),
    newId: () => `group-${++counter}`,
  });
  return { ...usecases, groups };
}

// --- Edge cases first -------------------------------------------------------

describe("channel groups — rejected writes", () => {
  it("rejects a malformed tenant id on every operation", async () => {
    const usecases = harness();
    await expect(usecases.listChannelGroups({ tenantId: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      usecases.createChannelGroup({ tenantId: "nope", name: "A", channelIds: ["fbpage-a"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      usecases.deleteChannelGroup({ tenantId: "nope", groupId: "group-1" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses an EMPTY group — it would be a click that posts nowhere", async () => {
    const usecases = harness();
    await expect(
      usecases.createChannelGroup({ tenantId: TENANT, name: "Trống", channelIds: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "channelIds" } });
    await expect(
      usecases.createChannelGroup({ tenantId: TENANT, name: "Trống", channelIds: ["   ", ""] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "channelIds" } });
    expect(usecases.groups.store.size).toBe(0);
  });

  it("refuses a group without a name", async () => {
    const usecases = harness();
    await expect(
      usecases.createChannelGroup({ tenantId: TENANT, name: "   ", channelIds: ["fbpage-a"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "name" } });
  });

  it("refuses a channel the tenant does not have (E7.6 core rule)", async () => {
    const usecases = harness();
    await expect(
      usecases.createChannelGroup({
        tenantId: TENANT,
        name: "Nhóm lạ",
        channelIds: ["fbpage-a", "fbpage-zzz"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "UNKNOWN_CHANNEL_ID", unknown_channels: ["fbpage-zzz"] },
    });
    expect(usecases.groups.store.size).toBe(0);
  });

  it("refuses a duplicate name (the unique index decides, not a pre-read)", async () => {
    const usecases = harness();
    await usecases.createChannelGroup({ tenantId: TENANT, name: "Tất cả", channelIds: ["fbpage-a"] });
    await expect(
      usecases.createChannelGroup({ tenantId: TENANT, name: "Tất cả", channelIds: ["fbpage-b"] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "CHANNEL_GROUP_NAME_TAKEN" },
    });
  });

  it("reports update/delete of a group that does not exist", async () => {
    const usecases = harness();
    await expect(
      usecases.updateChannelGroup({
        tenantId: TENANT,
        groupId: "missing",
        name: "X",
        channelIds: ["fbpage-a"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "GROUP_NOT_FOUND" } });
    await expect(
      usecases.deleteChannelGroup({ tenantId: TENANT, groupId: "missing" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "GROUP_NOT_FOUND" } });
  });

  it("validates membership on UPDATE too (a channel can disappear later)", async () => {
    const usecases = harness();
    const created = await usecases.createChannelGroup({
      tenantId: TENANT,
      name: "Nhóm A",
      channelIds: ["fbpage-a"],
    });
    await expect(
      usecases.updateChannelGroup({
        tenantId: TENANT,
        groupId: created.id,
        name: "Nhóm A",
        channelIds: ["fbpage-a", "fbpage-gone"],
      }),
    ).rejects.toMatchObject({ context: { unknown_channels: ["fbpage-gone"] } });
    // Untouched: a rejected update must not half-apply.
    expect(usecases.groups.store.get(created.id)?.channelIds).toEqual(["fbpage-a"]);
  });
});

// --- Happy path -------------------------------------------------------------

describe("channel groups — CRUD", () => {
  it("creates a group, normalising the name and de-duplicating channels", async () => {
    const usecases = harness();

    const created = await usecases.createChannelGroup({
      tenantId: TENANT,
      name: "  Toàn   bộ Page  ",
      channelIds: ["fbpage-a", " fbpage-b ", "fbpage-a"],
    });

    expect(created).toMatchObject({
      id: "group-1",
      name: "Toàn bộ Page",
      channelIds: ["fbpage-a", "fbpage-b"],
      channelCount: 2,
    });
  });

  it("lists, updates and deletes", async () => {
    const usecases = harness();
    const created = await usecases.createChannelGroup({
      tenantId: TENANT,
      name: "Nhóm A",
      channelIds: ["fbpage-a"],
    });

    const updated = await usecases.updateChannelGroup({
      tenantId: TENANT,
      groupId: created.id,
      name: "Nhóm A (mới)",
      channelIds: ["fbpage-b", "fbpage-c"],
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: "Nhóm A (mới)",
      channelIds: ["fbpage-b", "fbpage-c"],
      channelCount: 2,
    });

    expect(await usecases.listChannelGroups({ tenantId: TENANT })).toHaveLength(1);

    expect(await usecases.deleteChannelGroup({ tenantId: TENANT, groupId: created.id })).toEqual({
      groupId: created.id,
      deleted: true,
    });
    expect(await usecases.listChannelGroups({ tenantId: TENANT })).toEqual([]);
  });

  it("returns an empty list for a tenant with no group (not an error)", async () => {
    const usecases = harness();
    expect(await usecases.listChannelGroups({ tenantId: TENANT })).toEqual([]);
  });
});
