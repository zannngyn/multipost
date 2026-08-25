import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { PlatformAppearance } from "@/core/usecases/platform-appearance";
import { DEFAULT_APPEARANCE_PRESET_ID } from "@/shared/appearance-presets";

import { makeAppearanceGate } from "./appearance-gate";

function makeClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makeLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

const ACTOR = { actorAccountId: "acc-1", actorEmail: null };

describe("appearance gate", () => {
  it("reads once and serves the cache until the TTL runs out", async () => {
    const get = vi.fn(async () => ({ presetId: "reu" as const, isDefault: false }));
    const clock = makeClock();
    const gate = makeAppearanceGate({
      appearance: { get, set: vi.fn() } as unknown as PlatformAppearance,
      clock,
      logger: makeLogger(),
      ttlMs: 60_000,
    });

    await gate.get();
    await gate.get();
    await gate.get();
    expect(get).toHaveBeenCalledTimes(1);

    clock.advance(59_999);
    await gate.get();
    expect(get).toHaveBeenCalledTimes(1);

    clock.advance(2);
    await gate.get();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("shows a change made in this process at once", async () => {
    let stored = "cham";
    const appearance = {
      get: vi.fn(async () => ({ presetId: stored, isDefault: false })),
      set: vi.fn(async ({ presetId }: { presetId: string }) => {
        stored = presetId;
        return { presetId, already: false };
      }),
    } as unknown as PlatformAppearance;

    const gate = makeAppearanceGate({ appearance, clock: makeClock(), logger: makeLogger() });

    // The STORED value, not the default: this is about the cache, not fallback.
    await expect(gate.get()).resolves.toMatchObject({ presetId: "cham" });
    await gate.set({ ...ACTOR, presetId: "tia" });
    // No clock advance: the TTL has not moved, and it must not matter.
    await expect(gate.get()).resolves.toMatchObject({ presetId: "tia" });
  });

  it("drops the cache even when nothing changed", async () => {
    const get = vi.fn(async () => ({ presetId: "reu" as const, isDefault: false }));
    const gate = makeAppearanceGate({
      appearance: {
        get,
        set: vi.fn(async () => ({ presetId: "reu", already: true })),
      } as unknown as PlatformAppearance,
      clock: makeClock(),
      logger: makeLogger(),
    });

    await gate.get();
    await gate.set({ ...ACTOR, presetId: "reu" });
    await gate.get();

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("degrades to the default when the read fails — a page must still render", async () => {
    const logger = makeLogger();
    const gate = makeAppearanceGate({
      appearance: {
        get: vi.fn(async () => {
          throw new AppError("DB_ERROR", { message: "connection refused" });
        }),
        set: vi.fn(),
      } as unknown as PlatformAppearance,
      clock: makeClock(),
      logger,
    });

    await expect(gate.get()).resolves.toEqual({
      presetId: DEFAULT_APPEARANCE_PRESET_ID,
      isDefault: true,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ error_code: "DB_ERROR" });
  });

  it("does not cache a failure — the next request tries again", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new AppError("DB_ERROR", { message: "blip" }))
      .mockResolvedValue({ presetId: "man", isDefault: false });

    const gate = makeAppearanceGate({
      appearance: { get, set: vi.fn() } as unknown as PlatformAppearance,
      clock: makeClock(),
      logger: makeLogger(),
    });

    await expect(gate.get()).resolves.toMatchObject({ presetId: DEFAULT_APPEARANCE_PRESET_ID });
    await expect(gate.get()).resolves.toMatchObject({ presetId: "man" });
  });

  it("lets a write refusal through — saving is strict even though reading is not", async () => {
    const boom = new AppError("INVALID_INPUT", { message: "Unknown appearance preset" });
    const gate = makeAppearanceGate({
      appearance: {
        get: vi.fn(async () => ({ presetId: DEFAULT_APPEARANCE_PRESET_ID, isDefault: true })),
        set: vi.fn(async () => {
          throw boom;
        }),
      } as unknown as PlatformAppearance,
      clock: makeClock(),
      logger: makeLogger(),
    });

    await expect(gate.set({ ...ACTOR, presetId: "nope" })).rejects.toBe(boom);
  });

  it("invalidate() forces the next read to go back to the usecase", async () => {
    const get = vi.fn(async () => ({ presetId: DEFAULT_APPEARANCE_PRESET_ID, isDefault: true }));
    const gate = makeAppearanceGate({
      appearance: { get, set: vi.fn() } as unknown as PlatformAppearance,
      clock: makeClock(),
      logger: makeLogger(),
    });

    await gate.get();
    gate.invalidate();
    await gate.get();

    expect(get).toHaveBeenCalledTimes(2);
  });
});
