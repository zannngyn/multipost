/**
 * Sliding-window rate limiting, as a need (docs/07 §3.2). Pure TypeScript.
 * Redis / in-memory implementations live in `adapters/auth/`.
 *
 * Contract for every implementer:
 * - `consume` COUNTS the attempt it is asked about and answers whether it fits
 *   inside the window. It is not a read-only "check": two callers must not both
 *   see the last slot free;
 * - it NEVER throws. A limiter that is down must answer `allowed: true` and say
 *   so through its own logger — refusing every sign-in because Redis blinked is
 *   a self-inflicted outage, and the per-credential lock-out in Postgres is the
 *   defence that does survive it;
 * - `retryAfterMs` is 0 when allowed, and otherwise the wait until the OLDEST
 *   counted attempt leaves the window.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How many attempts are still free in this window after this call. */
  readonly remaining: number;
  /** 0 when allowed. Never negative. */
  readonly retryAfterMs: number;
}

export interface RateLimitRule {
  /** Attempts allowed inside `windowMs`. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimiter {
  /**
   * @param key Caller-namespaced, e.g. `auth:signin:ip:1.2.3.4`. The limiter
   *            does not know what a key means and must not parse one.
   */
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}
