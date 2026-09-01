import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `framer-motion` and `canvas-confetti` are ~40KB gzipped between them and they
 * exist for ONE route. Next splits by route, so the guarantee that the other
 * twelve screens do not pay for them is simply this: nothing outside
 * `onboarding/flow/` may import either package.
 *
 * A structural sweep, in the same spirit as `read-only-sweep.test.ts` — it
 * catches the regression that actually happens: someone reaches for a nice
 * transition on another screen and quietly widens the bundle everywhere.
 */

const SRC = fileURLToPath(new URL("../../../../..", import.meta.url));
const ALLOWED_PREFIX = join("ui", "components", "onboarding", "flow");
const FORBIDDEN = ["framer-motion", "canvas-confetti"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("motion dependencies stay on the onboarding route", () => {
  it("is imported nowhere outside onboarding/flow", () => {
    const offenders = walk(SRC)
      .filter((file) => !file.includes(ALLOWED_PREFIX))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return FORBIDDEN.some((pkg) => source.includes(`"${pkg}"`));
      })
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual([]);
  });
});
