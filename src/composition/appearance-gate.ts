import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  AppearanceSettings,
  PlatformAppearance,
  SetAppearanceInput,
  SetAppearanceResult,
} from "@/core/usecases/platform-appearance";
import { DEFAULT_APPEARANCE_PRESET_ID } from "@/shared/appearance-presets";

/**
 * A short cache over the platform appearance setting (M3.4).
 *
 * WHY IT HAS TO EXIST: the root layout reads this on the way to rendering ANY
 * page, sign-in included. Without a cache that is one database round trip added
 * to every request in the product, to answer a question whose answer changes
 * about once a year.
 *
 * WHY IT IS HERE AND NOT IN THE USECASE: same reason as the account gate —
 * core stays free of caching, and `set` is the only door, so nobody can write
 * the value through a path that forgets to drop the cache.
 *
 * WHAT THE TTL BUYS AND WHAT IT COSTS: a change made in THIS process is visible
 * at once. On a second app container the old colour can linger for up to
 * APPEARANCE_CACHE_TTL_MS. That is the deliberate trade: a minute of stale
 * BUTTON COLOUR on one replica, against a query per page view. Nothing here
 * authorises anything, so there is no security window to keep short.
 *
 * READING NEVER THROWS: a page must render even when the database is down —
 * the colour of a button is not a reason to 500 the sign-in screen. A failure
 * is logged with its cause and answers the approved default. It is NOT cached,
 * so a blip does not pin the wrong colour on for a minute after it clears.
 */

export const APPEARANCE_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly settings: AppearanceSettings;
  readonly expiresAt: number;
}

export interface AppearanceGate {
  /** Never throws. Degrades to the approved default and logs why. */
  get(): Promise<AppearanceSettings>;
  /** Writes through the usecase, then drops the cache. Throws on refusal. */
  set(input: SetAppearanceInput): Promise<SetAppearanceResult>;
  /** Drops the cached value. Exposed for tests and for future writers. */
  invalidate(): void;
}

export interface AppearanceGateDeps {
  appearance: PlatformAppearance;
  clock: Clock;
  logger: Logger;
  /** Injection seam for tests. Defaults to APPEARANCE_CACHE_TTL_MS. */
  ttlMs?: number;
}

export function makeAppearanceGate(deps: AppearanceGateDeps): AppearanceGate {
  const ttlMs =
    typeof deps.ttlMs === "number" && deps.ttlMs > 0 ? deps.ttlMs : APPEARANCE_CACHE_TTL_MS;
  let cache: CacheEntry | null = null;

  return {
    async get() {
      const now = deps.clock.nowMs();
      if (cache && cache.expiresAt > now) return cache.settings;

      try {
        const settings = await deps.appearance.get();
        cache = { settings, expiresAt: now + ttlMs };
        return settings;
      } catch (error) {
        deps.logger.error("Could not read the platform appearance — falling back to the default", {
          err: AppError.from(error, "DB_ERROR"),
          error_code: "DB_ERROR",
          fallback_preset: DEFAULT_APPEARANCE_PRESET_ID,
        });
        // Not cached: see the header. The next request tries again.
        return { presetId: DEFAULT_APPEARANCE_PRESET_ID, isDefault: true };
      }
    },

    async set(input) {
      const result = await deps.appearance.set(input);
      // Dropped even when `already` — the cheapest correct thing, and it makes
      // "save, then reload" honest no matter what the usecase decided.
      cache = null;
      return result;
    },

    invalidate() {
      cache = null;
    },
  };
}
