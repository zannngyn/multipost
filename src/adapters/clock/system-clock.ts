import type { Clock } from "@/core/ports/infra";

/** Wall-clock adapter. Tests inject a fake Clock instead of mocking Date. */
export function makeSystemClock(): Clock {
  return {
    now: () => new Date(),
    nowMs: () => Date.now(),
  };
}
