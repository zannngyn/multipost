import { describe, expect, it, vi } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";
import type { RateLimitRule } from "@/core/ports/rate-limiter";

import {
  makeMemoryRateLimiter,
  makeRedisRateLimiter,
  type RateLimitRedisClient,
} from "../sliding-window-rate-limiter";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };
const T0 = Date.UTC(2026, 7, 24, 9, 0, 0);

function movableClock(startMs = T0) {
  let nowMs = startMs;
  return {
    clock: { now: () => new Date(nowMs), nowMs: () => nowMs },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function recordingLogger() {
  const lines: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  };
  return { logger, lines };
}

// --- Edge cases first ---------------------------------------------------------

describe("memory limiter — unusable input never closes the door", () => {
  it.each([
    ["an empty key", "", RULE],
    ["a non-string key", 42 as unknown as string, RULE],
    ["a zero limit", "k", { limit: 0, windowMs: 1000 }],
    ["a zero window", "k", { limit: 5, windowMs: 0 }],
    ["a NaN limit", "k", { limit: Number.NaN, windowMs: 1000 }],
  ])("allows through on %s rather than refusing everybody", async (_label, key, rule) => {
    const { clock } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });
    await expect(limiter.consume(key, rule)).resolves.toMatchObject({ allowed: true });
  });
});

describe("memory limiter — the window", () => {
  it("allows exactly `limit` attempts, then refuses", async () => {
    const { clock } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });

    for (let attempt = 0; attempt < RULE.limit; attempt += 1) {
      await expect(limiter.consume("ip:1.2.3.4", RULE)).resolves.toMatchObject({ allowed: true });
    }
    const refused = await limiter.consume("ip:1.2.3.4", RULE);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBe(RULE.windowMs);
  });

  it("counts DOWN so a caller can warn before the wall", async () => {
    const { clock } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });
    expect((await limiter.consume("k", RULE)).remaining).toBe(2);
    expect((await limiter.consume("k", RULE)).remaining).toBe(1);
    expect((await limiter.consume("k", RULE)).remaining).toBe(0);
  });

  it("SLIDES: the oldest attempt frees a slot, the newest does not", async () => {
    // A fixed bucket would let 2x the limit through across a boundary — the
    // exact burst a credential-stuffing script is shaped to exploit.
    const { clock, advance } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });

    await limiter.consume("k", RULE); // t=0
    advance(30_000);
    await limiter.consume("k", RULE); // t=30s
    await limiter.consume("k", RULE); // t=30s
    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: false });

    advance(30_001); // t=60.001s — only the FIRST attempt has left the window
    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: false });
  });

  it("reports how long the wait actually is", async () => {
    const { clock, advance } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) await limiter.consume("k", RULE);

    advance(20_000);
    const refused = await limiter.consume("k", RULE);
    expect(refused.retryAfterMs).toBe(40_000);
  });

  it("keeps keys apart — one IP cannot spend another's budget", async () => {
    const { clock } = movableClock();
    const limiter = makeMemoryRateLimiter({ clock });
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) await limiter.consume("a", RULE);
    await expect(limiter.consume("a", RULE)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.consume("b", RULE)).resolves.toMatchObject({ allowed: true });
  });
});

// --- Redis --------------------------------------------------------------------

describe("redis limiter", () => {
  it("reads a well-formed reply", async () => {
    const { clock } = movableClock();
    const { logger } = recordingLogger();
    const connection: RateLimitRedisClient = { eval: vi.fn(async () => [1, 7, 0]) };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
    });

    await expect(limiter.consume("k", { limit: 10, windowMs: 1000 })).resolves.toEqual({
      allowed: true,
      remaining: 7,
      retryAfterMs: 0,
    });
  });

  it("refuses when the script says so, and passes the wait through", async () => {
    const { clock } = movableClock();
    const { logger } = recordingLogger();
    const connection: RateLimitRedisClient = { eval: vi.fn(async () => [0, 0, 4321]) };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
    });

    await expect(limiter.consume("k", RULE)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 4321,
    });
  });

  it("falls back to memory when Redis throws — and warns ONCE", async () => {
    const { clock } = movableClock();
    const { logger, lines } = recordingLogger();
    const connection: RateLimitRedisClient = {
      eval: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
    });

    // The fallback still counts: degrading must not mean "no limiter at all".
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) {
      await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: true });
    }
    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: false });

    // One dead Redis must not write a log line per login attempt.
    const warnings = lines.filter((line) => line.message.includes("fell back"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context?.reason).toBe("REDIS_UNAVAILABLE");
  });

  it.each([
    ["a string", "OK"],
    ["a short array", [1, 2]],
    ["non-numeric members", ["yes", "no", "maybe"]],
    ["null", null],
  ])("degrades to the fallback on an unreadable reply (%s)", async (_label, reply) => {
    const { clock } = movableClock();
    const { logger, lines } = recordingLogger();
    const connection: RateLimitRedisClient = { eval: vi.fn(async () => reply) };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
    });

    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: true });
    expect(lines.some((line) => line.context?.reason === "UNREADABLE_REPLY")).toBe(true);
  });

  it("does not hang on a Redis that never answers", async () => {
    // The BullMQ connection queues commands offline FOREVER; without the
    // timeout a dead Redis would hang the sign-in form instead of degrading it.
    const { clock } = movableClock();
    const { logger } = recordingLogger();
    const connection: RateLimitRedisClient = { eval: () => new Promise(() => {}) };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
      commandTimeoutMs: 20,
    });

    await expect(limiter.consume("k", RULE)).resolves.toMatchObject({ allowed: true });
  });

  it("clamps a reply that claims more headroom than the rule allows", async () => {
    const { clock } = movableClock();
    const { logger } = recordingLogger();
    const connection: RateLimitRedisClient = { eval: vi.fn(async () => [1, 999, -5]) };
    const limiter = makeRedisRateLimiter({
      connection,
      clock,
      logger,
      fallback: makeMemoryRateLimiter({ clock }),
    });

    await expect(limiter.consume("k", RULE)).resolves.toEqual({
      allowed: true,
      remaining: RULE.limit,
      retryAfterMs: 0,
    });
  });
});
