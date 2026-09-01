import { randomUUID } from "node:crypto";

import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { RateLimiter, RateLimitDecision, RateLimitRule } from "@/core/ports/rate-limiter";

/**
 * Sliding-window limiters for the sign-in / sign-up doors.
 *
 * A SLIDING window, not a fixed bucket: a fixed 15-minute bucket lets 2× the
 * limit through across a boundary (10 at 14:59, 10 more at 15:00), which is
 * exactly the burst a credential-stuffing script is shaped to exploit.
 *
 * TWO implementations behind one port:
 *   - Redis (a sorted set per key) — shared by every web process, survives a
 *     restart. What production uses;
 *   - in-memory — the fallback for a box without Redis, and what tests use.
 *     It counts PER PROCESS, so two Node processes each allow the full budget.
 *     That is a real weakening and it is why the per-credential lock-out lives
 *     in Postgres (core/domain/password-credential) instead of here.
 *
 * NEITHER EVER THROWS (port contract): a limiter that is down answers "allowed"
 * and shouts in the log. Refusing every sign-in because Redis blinked would be
 * a self-inflicted outage, and the database lock-out still holds.
 */

/** Prefix so a `KEYS mysp:*` never confuses these with queue or progress keys. */
const KEY_PREFIX = "mysp:ratelimit";

/**
 * Same reasoning as PROGRESS_COMMAND_TIMEOUT_MS: the connection may be the
 * BullMQ one (`maxRetriesPerRequest: null`), which queues commands offline
 * FOREVER instead of failing. Without a timeout a dead Redis would hang the
 * sign-in form rather than degrade it.
 */
export const RATE_LIMIT_COMMAND_TIMEOUT_MS = 1_000;

/**
 * The one command this limiter needs, as a structural type rather than the full
 * ioredis surface — a real `Redis` satisfies it as is, a test fakes it in five
 * lines, and `adapters/auth` does not import `adapters/queue` (docs/07 §2: no
 * cross-adapter imports).
 */
export interface RateLimitRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * One round trip, atomic — the read-then-write version lets two concurrent
 * attempts both see the last slot free, which is the only slot that matters.
 *
 * Returns `{allowed, remaining, retryAfterMs}` as three integers.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local used = redis.call('ZCARD', key)

if used >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then
    retry = math.ceil((tonumber(oldest[2]) + window) - now)
    if retry < 0 then retry = 0 end
  end
  return {0, 0, retry}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - used - 1, 0}
`;

const ALLOWED_WHEN_BROKEN: RateLimitDecision = { allowed: true, remaining: 0, retryAfterMs: 0 };

/** Rejects a rule that would divide by zero or allow nothing at all. */
function usableRule(rule: RateLimitRule): boolean {
  return (
    Number.isFinite(rule?.limit) &&
    Number.isFinite(rule?.windowMs) &&
    rule.limit > 0 &&
    rule.windowMs > 0
  );
}

function usableKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 0 && key.length <= 512;
}

// --- In-memory ---------------------------------------------------------------

/**
 * Cap on distinct keys held in memory. An attacker rotating IPs would otherwise
 * grow the map until the process dies — a rate limiter that can be turned into
 * an OOM is worse than none. On overflow the LEAST RECENTLY touched keys go
 * first (a Map iterates in insertion order and every touch re-inserts).
 */
const MEMORY_MAX_KEYS = 10_000;

export interface MemoryRateLimiterDeps {
  clock: Clock;
}

export function makeMemoryRateLimiter(deps: MemoryRateLimiterDeps): RateLimiter {
  const windows = new Map<string, number[]>();

  return {
    async consume(key, rule) {
      // --- Edge cases first ---------------------------------------------------
      if (!usableKey(key) || !usableRule(rule)) return ALLOWED_WHEN_BROKEN;

      const now = deps.clock.nowMs();
      const cutoff = now - rule.windowMs;
      const kept = (windows.get(key) ?? []).filter((stamp) => stamp > cutoff);

      if (kept.length >= rule.limit) {
        // Re-insert so an actively refused key stays hot and is not evicted
        // early — the eviction below must drop idle keys, not busy ones.
        windows.delete(key);
        windows.set(key, kept);
        const oldest = kept[0] ?? now;
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(0, Math.ceil(oldest + rule.windowMs - now)),
        };
      }

      kept.push(now);
      windows.delete(key);
      windows.set(key, kept);

      if (windows.size > MEMORY_MAX_KEYS) {
        const overflow = windows.size - MEMORY_MAX_KEYS;
        let dropped = 0;
        for (const stale of windows.keys()) {
          if (dropped >= overflow) break;
          windows.delete(stale);
          dropped += 1;
        }
      }

      return { allowed: true, remaining: rule.limit - kept.length, retryAfterMs: 0 };
    },
  };
}

// --- Redis -------------------------------------------------------------------

export interface RedisRateLimiterDeps {
  connection: RateLimitRedisClient;
  clock: Clock;
  logger: Logger;
  /** Falls back to this when Redis errors or times out. */
  fallback: RateLimiter;
  /** Override only in tests; see RATE_LIMIT_COMMAND_TIMEOUT_MS. */
  commandTimeoutMs?: number;
}

/**
 * REDIS IS EXTERNAL DATA: the Lua reply is parsed defensively. A reply that is
 * not three numbers means a script/server we do not understand, and guessing
 * would either lock everybody out or open the door silently — it degrades to
 * the fallback instead, loudly.
 */
function readDecision(reply: unknown, rule: RateLimitRule): RateLimitDecision | null {
  if (!Array.isArray(reply) || reply.length < 3) return null;
  const [allowed, remaining, retry] = reply.map((value) => Number(value));
  if (!Number.isFinite(allowed) || !Number.isFinite(remaining) || !Number.isFinite(retry)) {
    return null;
  }
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, Math.min(rule.limit, Math.trunc(remaining))),
    retryAfterMs: Math.max(0, Math.trunc(retry)),
  };
}

export function makeRedisRateLimiter(deps: RedisRateLimiterDeps): RateLimiter {
  const timeoutMs = deps.commandTimeoutMs ?? RATE_LIMIT_COMMAND_TIMEOUT_MS;
  const log = deps.logger.child({ component: "auth-rate-limiter" });
  /** Warn once per process — one dead Redis must not write a line per login. */
  let degradedWarned = false;

  const degrade = (
    key: string,
    rule: RateLimitRule,
    reason: string,
    error?: unknown,
  ): Promise<RateLimitDecision> => {
    if (!degradedWarned) {
      degradedWarned = true;
      log.warn("Auth rate limiter fell back to the in-memory window", {
        err: error === undefined ? undefined : AppError.from(error, "QUEUE_ERROR"),
        error_code: "AUTH_RATE_LIMITED",
        reason,
        alert: "OPERATOR_ATTENTION",
        user_message:
          "Bộ đếm chống dò mật khẩu đang chạy trong bộ nhớ tiến trình (Redis không dùng được) — giới hạn tính riêng từng tiến trình.",
      });
    }
    return deps.fallback.consume(key, rule);
  };

  return {
    async consume(key, rule) {
      // --- Edge cases first ---------------------------------------------------
      if (!usableKey(key) || !usableRule(rule)) return ALLOWED_WHEN_BROKEN;

      const now = deps.clock.nowMs();
      let reply: unknown;
      try {
        reply = await Promise.race([
          deps.connection.eval(
            SLIDING_WINDOW_SCRIPT,
            1,
            `${KEY_PREFIX}:${key}`,
            now,
            rule.windowMs,
            rule.limit,
            // Two attempts in the same millisecond must be two members, or the
            // sorted set would silently collapse them into one.
            `${now}-${randomUUID()}`,
          ),
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new AppError("QUEUE_ERROR", { message: "rate limiter timed out" })),
              timeoutMs,
            ).unref?.();
          }),
        ]);
      } catch (error) {
        return degrade(key, rule, "REDIS_UNAVAILABLE", error);
      }

      const decision = readDecision(reply, rule);
      if (!decision) return degrade(key, rule, "UNREADABLE_REPLY");
      return decision;
    },
  };
}
