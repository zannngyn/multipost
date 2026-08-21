import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Support mode is READ-ONLY (doc 09 §3.5): `useActiveTenant()` reports a support
 * session as `viewer`, and every screen that hands a role to a write control has
 * to take THAT value — not the raw membership role sitting on `tenant`. Read the
 * raw one and MYSP staff get a live "Tạo link mời" button whose only outcome is
 * a 403.
 *
 * `MembersHub` is the one place in this folder that picks the role up and passes
 * it on (to `InvitePanel`), so the invariant is pinned here.
 *
 * WHY IT IS A STRUCTURAL TEST, NOT A RENDERING ONE: same reason as
 * `components/read-only-sweep.test.ts` — `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom or testing-library, and adding
 * either is a dependency decision this ticket does not authorise. Deliberately
 * coarse — "which expression does this file use" — so honest refactors do not
 * break it, while the regression that actually happens (someone reaches for
 * `tenant.role` because it is right there) fails loudly.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * Comments are stripped before the negative assertion: the file EXPLAINS the
 * trap in prose, and a test that cannot tell prose from code would either fail
 * on the explanation or force the explanation to be deleted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("support mode: the members hub reads the role that support mode downgrades", () => {
  const source = readSource("./MembersHub.tsx");

  it("takes the role from useActiveTenant()", () => {
    expect(source).toContain("useActiveTenant");
    // …and actually calls it, rather than importing it and forgetting.
    expect(source).toMatch(/useActiveTenant\(\)/);
    // The downgraded field, destructured under whatever local name.
    expect(stripComments(source)).toMatch(/\brole\s*:/);
  });

  it("never reaches around it for the raw membership role", () => {
    const code = stripComments(source);
    expect(code).not.toMatch(/tenant\??\.role/);
    expect(code).not.toMatch(/tenants\s*\[/);
  });
});
