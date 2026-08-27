import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { AUTH_EMAIL_RULE, AUTH_IP_RULE, makeLazyAuthRateLimiter } from "@/composition/auth-rate-limiter";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeMemoryRateLimiter, makeRedisRateLimiter } from "../sliding-window-rate-limiter";

/**
 * The Lua sliding window against a REAL Redis — the half no fake client can
 * honestly answer for. Everything asserted here lives inside the script:
 *
 * 1. the production budgets actually bite: attempt 21 on the IP rule and
 *    attempt 11 on the e-mail rule are refused, and the two budgets are
 *    independent keys (burning one must not spend the other);
 * 2. `ZREMRANGEBYSCORE` really slides — once the oldest attempt leaves the
 *    window the slot comes back, both by moving the clock and by waiting out a
 *    short window in wall time;
 * 3. `PEXPIRE` really self-cleans, so a key nobody touches again does not live
 *    in Redis forever;
 * 4. the script is ATOMIC. This is the whole reason it is a script: with a
 *    read-then-write limiter, N concurrent attempts all see the last slot free.
 *    30 concurrent calls against a limit of 20 must let exactly 20 through;
 * 5. `composition/auth-rate-limiter` picks the REDIS path when a Redis is
 *    configured — no fallback warning, and the counter lands in Redis rather
 *    than in this process's memory.
 *
 * Runs only when a Redis is pointed at (skipped in the default suite — vitest
 * loads no .env, so this cannot silently depend on a developer's shell):
 *   TEST_REDIS_URL=redis://localhost:6379 pnpm test src/adapters/auth/sliding-window-rate-limiter.redis.integration.test.ts
 */

const url = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;

/** Mirrors the adapter's own prefix — the test asserts on real key names. */
const KEY_PREFIX = "mysp:ratelimit";

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

function recordingLogger() {
  const lines: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  };
  return { logger, lines };
}

function movableClock(startMs: number) {
  let nowMs = startMs;
  return {
    clock: { now: () => new Date(nowMs), nowMs: () => nowMs },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** The wall clock, for the one test that waits out a real window. */
const realClock = { now: () => new Date(), nowMs: () => Date.now() };

describe.skipIf(!url)("sliding window on a real Redis", () => {
  const connection = createRedisConnection({ url: url ?? "redis://unused", logger: silentLogger() });

  /**
   * Unique per run: a leftover key from an earlier run (or a developer's own
   * Redis) must never decide whether this suite passes, and the cleanup below
   * must never delete a key this test did not create.
   */
  const suffix = randomUUID().slice(0, 8);
  const used = new Set<string>();

  /** Records the logical key so `afterAll` can delete exactly what we made. */
  const key = (name: string): string => {
    const logical = `auth:test:${name}:${suffix}`;
    used.add(`${KEY_PREFIX}:${logical}`);
    return logical;
  };

  /**
   * A limiter on the SAME real connection, with a clock the test drives.
   *
   * The clock only decides the SCORE handed to the script, so driving it still
   * exercises the real `ZREMRANGEBYSCORE` pruning — while keeping the window
   * assertions deterministic instead of racing a 15-minute wall clock.
   */
  function withClock(startMs: number) {
    const { clock, advance } = movableClock(startMs);
    const fallbackHits = { count: 0 };
    const memory = makeMemoryRateLimiter({ clock });
    return {
      advance,
      limiter: makeRedisRateLimiter({
        connection,
        clock,
        logger: silentLogger(),
        // If Redis ever fell over mid-test we would silently be testing the
        // in-memory limiter instead. This makes that impossible to miss.
        fallback: {
          async consume(k, rule) {
            fallbackHits.count += 1;
            return memory.consume(k, rule);
          },
        },
      }),
      fallbackHits,
    };
  }

  beforeAll(async () => {
    // Fails loudly here rather than as a confusing assertion later.
    await expect(connection.ping()).resolves.toBe("PONG");
  });

  afterAll(async () => {
    if (used.size > 0) await connection.del(...used);
    const leftover = await Promise.all([...used].map((k) => connection.exists(k)));
    expect(leftover.every((count) => count === 0)).toBe(true);
    await connection.quit();
  });

  // --- The production budgets --------------------------------------------------

  it("lets 20 attempts through per IP and refuses the 21st (AUTH_IP_RULE)", async () => {
    const { limiter: rl, fallbackHits } = withClock(Date.now());
    const k = key("ip-budget");

    for (let attempt = 1; attempt <= AUTH_IP_RULE.limit; attempt += 1) {
      const decision = await rl.consume(k, AUTH_IP_RULE);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(AUTH_IP_RULE.limit - attempt);
      expect(decision.retryAfterMs).toBe(0);
    }

    const refused = await rl.consume(k, AUTH_IP_RULE);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    // The oldest attempt was made at t0, so the wait is the whole window.
    expect(refused.retryAfterMs).toBe(AUTH_IP_RULE.windowMs);

    // Redis holds exactly the 20 that were counted — the refusal added nothing.
    expect(await connection.zcard(`${KEY_PREFIX}:${k}`)).toBe(AUTH_IP_RULE.limit);
    expect(fallbackHits.count).toBe(0);
  });

  it("lets 10 attempts through per e-mail and refuses the 11th (AUTH_EMAIL_RULE)", async () => {
    const { limiter: rl, fallbackHits } = withClock(Date.now());
    const k = key("email-budget");

    for (let attempt = 1; attempt <= AUTH_EMAIL_RULE.limit; attempt += 1) {
      await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: true });
    }

    await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: AUTH_EMAIL_RULE.windowMs,
    });
    expect(await connection.zcard(`${KEY_PREFIX}:${k}`)).toBe(AUTH_EMAIL_RULE.limit);
    expect(fallbackHits.count).toBe(0);
  });

  it("keeps the IP and e-mail budgets independent", async () => {
    // Exhausting one must not spend the other: they answer different questions
    // (one office behind a NAT vs. a distributed run at one account).
    const { limiter: rl } = withClock(Date.now());
    const ipKey = key("split-ip");
    const emailKey = key("split-email");

    for (let attempt = 0; attempt < AUTH_EMAIL_RULE.limit; attempt += 1) {
      await rl.consume(emailKey, AUTH_EMAIL_RULE);
    }
    await expect(rl.consume(emailKey, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: false });
    await expect(rl.consume(ipKey, AUTH_IP_RULE)).resolves.toMatchObject({
      allowed: true,
      remaining: AUTH_IP_RULE.limit - 1,
    });
  });

  // --- The window really slides -------------------------------------------------

  it("reports the shrinking wait as the window rolls forward", async () => {
    const { limiter: rl, advance } = withClock(Date.now());
    const k = key("retry-after");

    for (let attempt = 0; attempt < AUTH_EMAIL_RULE.limit; attempt += 1) {
      await rl.consume(k, AUTH_EMAIL_RULE);
    }
    advance(AUTH_EMAIL_RULE.windowMs / 3);
    const refused = await rl.consume(k, AUTH_EMAIL_RULE);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(Math.ceil((AUTH_EMAIL_RULE.windowMs * 2) / 3));
  });

  it("frees exactly the slots that left the window, not the whole bucket", async () => {
    // A FIXED bucket would hand back all 10 at the boundary — 2x the limit in
    // one burst, which is the shape a credential-stuffing script exploits.
    const { limiter: rl, advance } = withClock(Date.now());
    const k = key("slides");

    // Two attempts now, the remaining eight half a window later.
    await rl.consume(k, AUTH_EMAIL_RULE);
    await rl.consume(k, AUTH_EMAIL_RULE);
    advance(AUTH_EMAIL_RULE.windowMs / 2);
    for (let attempt = 0; attempt < AUTH_EMAIL_RULE.limit - 2; attempt += 1) {
      await rl.consume(k, AUTH_EMAIL_RULE);
    }
    await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: false });

    // Just past the window from t0: only the FIRST TWO have aged out.
    advance(AUTH_EMAIL_RULE.windowMs / 2 + 1);
    await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: true });
    await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: true });
    await expect(rl.consume(k, AUTH_EMAIL_RULE)).resolves.toMatchObject({ allowed: false });
    expect(await connection.zcard(`${KEY_PREFIX}:${k}`)).toBe(AUTH_EMAIL_RULE.limit);
  });

  it("opens back up after a SHORT window expires in real time", async () => {
    // Wall-clock proof, not a moved clock: the scores Redis prunes against are
    // real timestamps here, and PEXPIRE is running for real too.
    const rule = { limit: 2, windowMs: 400 };
    const rl = makeRedisRateLimiter({
      connection,
      clock: realClock,
      logger: silentLogger(),
      fallback: makeMemoryRateLimiter({ clock: realClock }),
    });
    const k = key("short-window");

    await expect(rl.consume(k, rule)).resolves.toMatchObject({ allowed: true });
    await expect(rl.consume(k, rule)).resolves.toMatchObject({ allowed: true });
    const refused = await rl.consume(k, rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(rule.windowMs);

    // PEXPIRE bounds the key's life so an untouched bucket cleans itself up.
    const ttl = await connection.pttl(`${KEY_PREFIX}:${k}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(rule.windowMs);

    await new Promise((resolve) => setTimeout(resolve, rule.windowMs + 150));
    await expect(rl.consume(k, rule)).resolves.toMatchObject({ allowed: true });
  });

  // --- Atomicity: the reason it is a script -------------------------------------

  it("lets EXACTLY the limit through under 30 concurrent attempts", async () => {
    const { limiter: rl, fallbackHits } = withClock(Date.now());
    const k = key("concurrent");

    const decisions = await Promise.all(
      Array.from({ length: 30 }, () => rl.consume(k, AUTH_IP_RULE)),
    );
    const allowed = decisions.filter((decision) => decision.allowed).length;

    // A read-then-write limiter lets more than 20 through here — the last slot
    // is the only slot an attacker cares about.
    expect(allowed).toBe(AUTH_IP_RULE.limit);
    expect(decisions.length - allowed).toBe(10);
    expect(await connection.zcard(`${KEY_PREFIX}:${k}`)).toBe(AUTH_IP_RULE.limit);
    expect(fallbackHits.count).toBe(0);

    // Same millisecond, distinct members: without the uuid the sorted set would
    // silently collapse concurrent attempts into one.
    // String bounds: ioredis 6 types `stop` as string|Buffer (the BYSCORE/BYLEX
    // overloads share the signature). Redis sees the same `ZRANGE key 0 -1`.
    const members = await connection.zrange(`${KEY_PREFIX}:${k}`, 0, "-1");
    expect(new Set(members).size).toBe(AUTH_IP_RULE.limit);
  });

  // --- The composition factory --------------------------------------------------

  it("composition takes the REDIS path when a Redis is configured — no fallback warning", async () => {
    const { logger, lines } = recordingLogger();
    const { clock } = movableClock(Date.now());
    const authLimiter = makeLazyAuthRateLimiter({ redisUrl: url ?? "", clock, logger });
    const k = key("composition");

    try {
      const decision = await authLimiter.consume(k, AUTH_IP_RULE);
      expect(decision).toEqual({ allowed: true, remaining: AUTH_IP_RULE.limit - 1, retryAfterMs: 0 });

      // THE proof it went through Redis and not through process memory: the
      // counter is visible from a different connection. `remaining` alone could
      // not tell the two apart — both limiters would answer 19.
      expect(await connection.zcard(`${KEY_PREFIX}:${k}`)).toBe(1);

      const degraded = lines.filter(
        (line) =>
          line.message.includes("fell back") || line.message.includes("No Redis for the auth"),
      );
      expect(degraded).toEqual([]);
    } finally {
      await authLimiter.close();
    }
  });

  it("composition survives close() being called twice", async () => {
    const { logger } = recordingLogger();
    const { clock } = movableClock(Date.now());
    const authLimiter = makeLazyAuthRateLimiter({ redisUrl: url ?? "", clock, logger });
    await authLimiter.consume(key("close-twice"), AUTH_IP_RULE);
    await authLimiter.close();
    // closeContainer() drains a set of closers; a second drain must be a no-op.
    await expect(authLimiter.close()).resolves.toBeUndefined();
  });
});
