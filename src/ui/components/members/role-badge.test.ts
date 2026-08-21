import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MEMBERSHIP_ROLE_BADGE_TONES } from "@/ui/components/members/role-badge";
import { ACCESS_ROLES } from "@/ui/schemas/access-request.schema";

/**
 * The bug this pins: "Chủ sở hữu" was purple in the member table and blue in
 * the invite table — the same role, two colours, one tab apart. Colour is a
 * cheap way to say "these are the same thing"; two of them says they are not.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** Comments are stripped first: prose about a variant is not a use of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("membership role badge tones", () => {
  it("has a tone for every role the access vocabulary defines", () => {
    // A role added to `ACCESS_ROLES` with no tone here would be `undefined` at
    // runtime and render Astryx's default grey with no warning.
    for (const role of ACCESS_ROLES) {
      expect(MEMBERSHIP_ROLE_BADGE_TONES[role]).toBeTruthy();
    }
    expect(Object.keys(MEMBERSHIP_ROLE_BADGE_TONES).sort()).toEqual([...ACCESS_ROLES].sort());
  });

  it("keeps owner apart and the other three together", () => {
    expect(MEMBERSHIP_ROLE_BADGE_TONES.owner).not.toBe(MEMBERSHIP_ROLE_BADGE_TONES.admin);
    expect(MEMBERSHIP_ROLE_BADGE_TONES.admin).toBe(MEMBERSHIP_ROLE_BADGE_TONES.editor);
    expect(MEMBERSHIP_ROLE_BADGE_TONES.editor).toBe(MEMBERSHIP_ROLE_BADGE_TONES.viewer);
  });

  /**
   * The values are pinned, not just their relationship — and they CHANGED with
   * the swatch-book redesign: owner used to be `purple`, and purple is the
   * accent of the generic admin SaaS this design refuses. Owner wears the
   * world's indigo now, the other three the neutral of a woven label. Anyone
   * reaching for a decorative colour here has to come through this assertion.
   */
  it("dresses the roles in the world's own colours, never purple", () => {
    expect(MEMBERSHIP_ROLE_BADGE_TONES).toEqual({
      owner: "blue",
      admin: "neutral",
      editor: "neutral",
      viewer: "neutral",
    });
    expect(Object.values(MEMBERSHIP_ROLE_BADGE_TONES)).not.toContain("purple");
  });

  /**
   * Structural, for the same reason as `members-hub-sweep.test.ts`: vitest runs
   * in `environment: "node"` and this repo has no jsdom, so there is nothing to
   * render into. Coarse on purpose — it asks "does this file decide a role
   * colour by itself", which is exactly how the two tables drifted apart.
   */
  describe.each([
    ["MemberTable.tsx", "member.role"],
    ["InvitePanel.tsx", "invite.role"],
  ])("%s", (file) => {
    const code = stripComments(readSource(`./${file}`));

    it("takes the role colour from the shared table", () => {
      expect(code).toContain("MEMBERSHIP_ROLE_BADGE_TONES[");
    });

    it("never spells a role colour out on the spot", () => {
      // Status badges (`variant={INVITE_STATUS_TONES[...]}`, `variant="warning"`)
      // are a different vocabulary and stay allowed; these are the category
      // colours, and a literal one here means a second opinion about a role.
      // `purple` stays in the list although no role wears it any more: a file
      // spelling it out would be reintroducing exactly the tone the redesign
      // took out.
      expect(code).not.toMatch(/variant="(purple|blue|neutral)"/);
      expect(code).not.toMatch(/=== "owner" \?/);
    });
  });
});
