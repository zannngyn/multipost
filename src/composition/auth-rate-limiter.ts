import { createRedisConnection } from "@/adapters/queue/redis-connection";
import {
  makeMemoryRateLimiter,
  makeRedisRateLimiter,
} from "@/adapters/auth/sliding-window-rate-limiter";
import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { RateLimiter, RateLimitRule } from "@/core/ports/rate-limiter";

/**
 * The limiter in front of the sign-in / sign-up doors, wired lazily.
 *
 * LAZY for the same reason as the job queue and the progress store in
 * container.ts: `next build` and an ordinary page render must not require a
 * reachable Redis. The connection is opened by the FIRST login attempt, not by
 * importing the container.
 *
 * FALLS BACK, never fails: a box with no Redis at all (a laptop, a smoke test)
 * still gets a working limiter — in process memory, counted per process, which
 * is weaker and says so once in the log. The defence that does survive Redis
 * being down is the per-credential lock-out in Postgres.
 */

/**
 * Per-IP budget for login+register combined. Generous enough for an office
 * behind one NAT address (a shared IP is one key for everybody in the room),
 * tight enough that a single host cannot grind through a password list.
 */
export const AUTH_IP_RULE: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Per-ADDRESS budget. Lower than the IP one and independent of it: this is the
 * one that bites a distributed attempt against a single known account, where
 * every request arrives from a different IP.
 */
export const AUTH_EMAIL_RULE: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

export interface AuthRateLimiterDeps {
  redisUrl: string;
  clock: Clock;
  logger: Logger;
}

/** The port plus the shutdown hook `closeContainer` needs. */
export interface AuthRateLimiter extends RateLimiter {
  /** Drains the lazily opened connection. No-op when none was ever opened. */
  close(): Promise<void>;
}

export function makeLazyAuthRateLimiter(deps: AuthRateLimiterDeps): AuthRateLimiter {
  const memory = makeMemoryRateLimiter({ clock: deps.clock });
  let real: RateLimiter | null = null;
  let closer: (() => Promise<void>) | null = null;

  const build = (): RateLimiter => {
    if (real) return real;

    try {
      const connection = createRedisConnection({ url: deps.redisUrl, logger: deps.logger });
      real = makeRedisRateLimiter({
        connection,
        clock: deps.clock,
        logger: deps.logger,
        fallback: memory,
      });
      closer = async () => {
        real = null;
        await connection.quit();
      };
    } catch (error) {
      /**
       * `createRedisConnection` throws on an EMPTY url — a deployment that
       * simply has no Redis. Not swallowed: it is logged with its code, and the
       * in-memory limiter takes over permanently (so the throw happens once,
       * not on every login).
       */
      deps.logger.warn("No Redis for the auth rate limiter — counting in process memory", {
        err: AppError.from(error, "QUEUE_ERROR"),
        error_code: "QUEUE_ERROR",
        reason: "REDIS_NOT_CONFIGURED",
        alert: "OPERATOR_ATTENTION",
      });
      real = memory;
    }
    return real;
  };

  return {
    consume: (key, rule) => build().consume(key, rule),
    async close() {
      const close = closer;
      closer = null;
      if (close) await close();
    },
  };
}
