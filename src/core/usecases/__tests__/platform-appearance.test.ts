import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type {
  AppearanceSettingRepo,
  WriteAppearancePresetRecord,
} from "@/core/ports/appearance-setting-repo";
import type { Logger } from "@/core/ports/infra";
import { DEFAULT_APPEARANCE_PRESET_ID } from "@/shared/appearance-presets";

import { makePlatformAppearance } from "../platform-appearance";

/**
 * Edge cases first (CLAUDE.md §1): every way the stored value can be wrong, and
 * every way a caller can be wrong, before the one path where both are right.
 */

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

function makeRepo(stored: unknown): AppearanceSettingRepo & {
  writes: WriteAppearancePresetRecord[];
} {
  const writes: WriteAppearancePresetRecord[] = [];
  return {
    writes,
    read: async () => stored,
    write: async (record) => {
      writes.push(record);
    },
  };
}

const ACTOR = { actorAccountId: "acc-1", actorEmail: "staff@mysp.vn" };

describe("get()", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  it("reports the approved default when nothing was ever stored", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo(null), logger });

    await expect(appearance.get()).resolves.toEqual({
      presetId: DEFAULT_APPEARANCE_PRESET_ID,
      isDefault: true,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats undefined like an absent row", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo(undefined), logger });

    await expect(appearance.get()).resolves.toEqual({
      presetId: DEFAULT_APPEARANCE_PRESET_ID,
      isDefault: true,
    });
  });

  it.each([
    ["a retired preset id", "indigo-2024"],
    ["an empty string", ""],
    ["a number", 7],
    ["an object", { presetId: "cham" }],
    ["an array", ["cham"]],
    ["a boolean", true],
  ])("falls back and WARNS on %s", async (_label, stored) => {
    const appearance = makePlatformAppearance({ settings: makeRepo(stored), logger });

    await expect(appearance.get()).resolves.toEqual({
      presetId: DEFAULT_APPEARANCE_PRESET_ID,
      isDefault: true,
    });

    // Degraded, not swallowed: the offending value must be in the log line, or
    // nobody can explain why the colour reverted.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls[0];
    expect(message).toMatch(/not a known preset/i);
    expect(context).toMatchObject({ error_code: "INVALID_INPUT" });
    expect(String(context.stored_value)).toContain(
      typeof stored === "string" ? stored : String(JSON.stringify(stored)).slice(0, 4),
    );
  });

  it("never throws when the value is unusable — reading must not take pages down", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo("nonsense"), logger });
    await expect(appearance.get()).resolves.toBeDefined();
  });

  it("reports a stored preset as a real choice", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo("reu"), logger });

    await expect(appearance.get()).resolves.toEqual({ presetId: "reu", isDefault: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("propagates a repository failure rather than inventing a colour", async () => {
    const boom = new AppError("DB_ERROR", { message: "connection refused" });
    const appearance = makePlatformAppearance({
      settings: {
        read: async () => {
          throw boom;
        },
        write: async () => undefined,
      },
      logger,
    });

    await expect(appearance.get()).rejects.toBe(boom);
  });
});

describe("set()", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  it.each([
    ["an unknown id", "neon-pink"],
    ["an empty string", ""],
    ["a label instead of an id", "Chàm"],
    ["different casing", "CHAM"],
  ])("refuses %s with INVALID_INPUT and writes nothing", async (_label, presetId) => {
    const repo = makeRepo(null);
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(appearance.set({ ...ACTOR, presetId })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(repo.writes).toHaveLength(0);
  });

  it("carries a Vietnamese message an operator can act on", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo(null), logger });

    await expect(appearance.set({ ...ACTOR, presetId: "nope" })).rejects.toMatchObject({
      userMessage: expect.stringContaining("Bộ màu không hợp lệ"),
    });
  });

  it("refuses a session with no account", async () => {
    const repo = makeRepo(null);
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(
      appearance.set({ presetId: "reu", actorAccountId: "", actorEmail: null }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(repo.writes).toHaveLength(0);
  });

  it("writes the choice, with what it replaced", async () => {
    const repo = makeRepo("cham");
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(appearance.set({ ...ACTOR, presetId: "tia" })).resolves.toEqual({
      presetId: "tia",
      already: false,
    });
    expect(repo.writes).toEqual([
      {
        presetId: "tia",
        actorAccountId: "acc-1",
        actorEmail: "staff@mysp.vn",
        previousPresetId: "cham",
      },
    ]);
  });

  it("records no previous id when the app was still on the untouched default", async () => {
    const repo = makeRepo(null);
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await appearance.set({ ...ACTOR, presetId: "man" });

    expect(repo.writes[0]).toMatchObject({ previousPresetId: null });
  });

  it("is idempotent — re-picking the live colour writes nothing and audits nothing", async () => {
    const repo = makeRepo("reu");
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(appearance.set({ ...ACTOR, presetId: "reu" })).resolves.toEqual({
      presetId: "reu",
      already: true,
    });
    expect(repo.writes).toHaveLength(0);
  });

  it("DOES write when the live colour is only the fallback default", async () => {
    // Nothing stored: picking the default is still a real decision, and the
    // row has to exist so a later deploy can tell "chose chàm" from "never set".
    const repo = makeRepo(null);
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(
      appearance.set({ ...ACTOR, presetId: DEFAULT_APPEARANCE_PRESET_ID }),
    ).resolves.toEqual({ presetId: DEFAULT_APPEARANCE_PRESET_ID, already: false });
    expect(repo.writes).toHaveLength(1);
  });

  it("overwrites a value that had become unknown", async () => {
    const repo = makeRepo("retired-preset");
    const appearance = makePlatformAppearance({ settings: repo, logger });

    await expect(appearance.set({ ...ACTOR, presetId: "reu" })).resolves.toEqual({
      presetId: "reu",
      already: false,
    });
    // The unknown value read as "default", so there is no previous id to name.
    expect(repo.writes[0]).toMatchObject({ previousPresetId: null });
  });

  it("logs the change with the actor", async () => {
    const appearance = makePlatformAppearance({ settings: makeRepo("cham"), logger });

    await appearance.set({ ...ACTOR, presetId: "ca-phe" });

    expect(logger.info).toHaveBeenCalledWith(
      "Platform appearance changed",
      expect.objectContaining({
        preset_id: "ca-phe",
        previous_preset_id: "cham",
        actor_account_id: "acc-1",
      }),
    );
  });
});
