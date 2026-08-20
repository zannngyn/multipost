import { describe, expect, it } from "vitest";

import { canChangeMemberRole, canRemoveMember } from "./member-policy";

/**
 * The M2.3 ladder, exhaustively — this table IS the permission contract
 * (doc 10 §4.4 as settled after the M0 gate), and every hole in it is a
 * quiet takeover path.
 */

describe("canChangeMemberRole", () => {
  // --- Admin: only editor/viewer, both sides --------------------------------
  it.each([
    ["editor", "viewer", true],
    ["viewer", "editor", true],
    ["editor", "editor", true],
  ] as const)("admin may move %s -> %s", (target, next, allowed) => {
    expect(canChangeMemberRole("admin", target, next).allowed).toBe(allowed);
  });

  it.each([
    ["editor", "admin"], // promotion past editor — owner's job
    ["editor", "owner"],
    ["admin", "editor"], // touching another admin at all
    ["admin", "admin"],
    ["owner", "viewer"], // touching an owner at all
  ] as const)("admin may NOT move %s -> %s", (target, next) => {
    expect(canChangeMemberRole("admin", target, next)).toEqual({
      allowed: false,
      reason: "LADDER",
    });
  });

  // --- Owner: everything (LAST_OWNER is counted in the transaction) ---------
  it.each([
    ["admin", "owner"],
    ["owner", "viewer"],
    ["viewer", "owner"],
  ] as const)("owner may move %s -> %s", (target, next) => {
    expect(canChangeMemberRole("owner", target, next).allowed).toBe(true);
  });

  // --- Below admin: nothing (routes gate at admin anyway — belt) ------------
  it("editor and viewer may change nobody", () => {
    expect(canChangeMemberRole("editor", "viewer", "viewer").allowed).toBe(false);
    expect(canChangeMemberRole("viewer", "viewer", "viewer").allowed).toBe(false);
  });
});

describe("canRemoveMember", () => {
  it("admin removes editor/viewer, not admin/owner", () => {
    expect(canRemoveMember("admin", "editor", false).allowed).toBe(true);
    expect(canRemoveMember("admin", "viewer", false).allowed).toBe(true);
    expect(canRemoveMember("admin", "admin", false).allowed).toBe(false);
    expect(canRemoveMember("admin", "owner", false).allowed).toBe(false);
  });

  it("owner removes anyone", () => {
    expect(canRemoveMember("owner", "admin", false).allowed).toBe(true);
    expect(canRemoveMember("owner", "owner", false).allowed).toBe(true);
  });

  it("removing YOURSELF is leaving — allowed even for an admin removing an admin (self)", () => {
    expect(canRemoveMember("admin", "admin", true).allowed).toBe(true);
    expect(canRemoveMember("owner", "owner", true).allowed).toBe(true);
  });
});
