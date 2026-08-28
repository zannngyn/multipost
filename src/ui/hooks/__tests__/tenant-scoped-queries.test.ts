import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the invariant the first-run wizard is built on (spec §6).
 *
 * `FirstRunGate` renders the real overview BEHIND the wizard while the account
 * still has no company. That is only safe because `useActiveTenant().isResolved`
 * is false in that state and every tenant-scoped query is `enabled: isResolved`
 * — so not one request goes out and the screen simply draws its own frame.
 *
 * A hook that reads `useActiveTenant` and then fires unconditionally breaks it
 * quietly: the screen behind the dialog would spray 409s at the API on a page
 * nobody can even interact with. Nothing about the wizard would look wrong, so
 * this is the only place it would be caught.
 *
 * A LEXICAL check, deliberately: rendering every hook would need a query client,
 * a router and a fetch double per hook, and would still only prove the one path
 * the test happened to set up. Reading the source proves the gate exists at all,
 * which is the property being defended.
 */

const HOOKS_DIR = join(process.cwd(), "src/ui/hooks");

/**
 * Hooks allowed to read `useActiveTenant` without an `enabled` gate, each for a
 * stated reason. Adding a name here is a decision, not a formality.
 */
const EXEMPT = new Map<string, string>([
  [
    "useMe.ts",
    "It IS the source: useActiveTenant reads its result, so it cannot wait on itself.",
  ],
  [
    "useSetupProgress.ts",
    "Contains a useQuery WITH enabled plus a plain invalidation helper; the helper has no query to gate.",
  ],
]);

function hookFiles(): readonly string[] {
  return readdirSync(HOOKS_DIR).filter(
    (name) => name.startsWith("use") && name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
}

/**
 * A CALL, not a mention. `useQueryClient` contains the substring "useQuery" and
 * a plain-includes check reads a hook that only invalidates caches as one that
 * opens a query — which is how this test first accused `useBulkRun` of a bug it
 * does not have.
 */
const OPENS_A_QUERY = /\buse(Infinite)?Query\s*[(<]/;

describe("tenant-scoped hooks", () => {
  /**
   * Every check below `return`s early for a file that does not match, so a
   * refactor that moved the hooks — or a regex that stopped matching — would
   * leave this suite green while asserting nothing at all. This is the guard
   * against that: the per-file cases only mean something if real files reach
   * them. Raise the floor, never lower it to make a run pass.
   */
  it("actually reaches the assertion for the tenant-scoped hooks", () => {
    const matched = hookFiles().filter((name) => {
      const source = readFileSync(join(HOOKS_DIR, name), "utf8");
      return source.includes("useActiveTenant") && OPENS_A_QUERY.test(source);
    });
    expect(matched.length).toBeGreaterThanOrEqual(15);
  });

  it.each(hookFiles())("%s gates its queries on the active tenant", (name) => {
    const source = readFileSync(join(HOOKS_DIR, name), "utf8");

    const readsTenant = source.includes("useActiveTenant");
    if (!readsTenant || !OPENS_A_QUERY.test(source)) return;

    if (EXEMPT.has(name)) {
      // Assert the exemption is still needed — a hook that grew an `enabled`
      // should be taken off the list rather than left there rotting.
      expect(EXEMPT.get(name)).toBeTruthy();
      return;
    }

    expect(
      source.includes("enabled:"),
      `${name} reads useActiveTenant and opens a query but never sets \`enabled\`. ` +
        "While an account has no company it would fire against a tenant that does not exist " +
        "(spec §6). Add `enabled: isResolved`, or add the file to EXEMPT with a reason.",
    ).toBe(true);
  });
});
