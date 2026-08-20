import { describe, expect, it } from "vitest";

import {
  MemberListResponseSchema,
  ROLE_RANK,
  assignableRoles,
  canManageMembers,
  memberActionBlockReason,
  memberDisplayName,
  memberStatusLabel,
  removeMemberConsequence,
  roleChangeBlockReason,
} from "./member.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that must never
 * regress: the LADDER (doc 10 §1). Client-side it is only UX — the server
 * refuses regardless — but a UI that offers what the server will refuse teaches
 * operators to distrust the buttons, and one that hides what they may do makes
 * them ask an owner for nothing.
 */

const OWNER_ROW = {
  membershipId: "m-owner",
  accountId: "a-owner",
  displayName: "Chị Chủ",
  email: "owner@mysp.vn",
  role: "owner" as const,
  status: "active",
  joinedAt: "2026-08-01T09:00:00+07:00",
  isYou: false,
};

describe("MemberListResponseSchema", () => {
  it("accepts the payload the API returns", () => {
    const parsed = MemberListResponseSchema.safeParse({ items: [OWNER_ROW] });
    expect(parsed.success).toBe(true);
  });

  /** Recorded from the running API (GET /api/members) — the real contract. */
  it("accepts the live payload, field for field", () => {
    const parsed = MemberListResponseSchema.safeParse({
      items: [
        {
          membershipId: "ccc67df8-efc8-4740-8d1c-907194ac43aa",
          accountId: "8447c5dc-cca4-453e-b334-e0f1d5276b23",
          displayName: "Dev Bypass",
          email: "dev@localhost",
          role: "owner",
          status: "active",
          joinedAt: "2026-08-19T10:13:28.916Z",
          isYou: true,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    // `isYou` is the server's call, never inferred here — it decides which row
    // says "(bạn)" and which write also re-reads /api/me.
    expect(parsed.success && parsed.data.items[0]?.isYou).toBe(true);
  });

  it("accepts an account with no e-mail and no name", () => {
    const parsed = MemberListResponseSchema.safeParse({
      items: [{ ...OWNER_ROW, displayName: null, email: null }],
    });
    expect(parsed.success).toBe(true);
    // …and the row still has something to call the person.
    expect(memberDisplayName({ displayName: null, email: null })).toBe("(chưa có tên)");
    expect(memberDisplayName({ displayName: "  ", email: "a@mysp.vn" })).toBe("a@mysp.vn");
  });

  it("rejects a role the UI cannot render", () => {
    expect(
      MemberListResponseSchema.safeParse({ items: [{ ...OWNER_ROW, role: "superuser" }] }).success,
    ).toBe(false);
  });

  it("rejects a membership with no id — no action could address it", () => {
    expect(
      MemberListResponseSchema.safeParse({ items: [{ ...OWNER_ROW, membershipId: "" }] }).success,
    ).toBe(false);
  });

  it("keeps an unknown status visible instead of flattening it to 'active'", () => {
    const parsed = MemberListResponseSchema.safeParse({
      items: [{ ...OWNER_ROW, status: "pending_review" }],
    });
    expect(parsed.success).toBe(true);
    expect(memberStatusLabel("pending_review")).toBe("pending_review");
    expect(memberStatusLabel("active")).toBe("Đang hoạt động");
  });

  it("rejects an unparseable joinedAt instead of showing an invalid date", () => {
    expect(
      MemberListResponseSchema.safeParse({ items: [{ ...OWNER_ROW, joinedAt: "01/08/2026" }] })
        .success,
    ).toBe(false);
  });
});

describe("the ladder", () => {
  it("orders viewer < editor < admin < owner", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
  });

  it("lets an owner grant anything, including ownership", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("stops an admin from minting an admin or an owner", () => {
    // This is the rule that keeps an admin from promoting themselves past their
    // own ceiling, one hop at a time.
    expect(assignableRoles("admin")).toEqual(["editor", "viewer"]);
  });

  it("gives editor and viewer nothing to grant", () => {
    expect(assignableRoles("editor")).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers(null)).toBe(false);
  });
});

describe("memberActionBlockReason", () => {
  const target = (role: "owner" | "admin" | "editor" | "viewer", isYou = false) => ({ role, isYou });

  it("lets an owner act on everyone, themselves included", () => {
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      expect(memberActionBlockReason("owner", target(role))).toBeNull();
    }
    expect(memberActionBlockReason("owner", target("owner", true))).toBeNull();
  });

  it("stops an admin at another admin or an owner, with a reason", () => {
    const onAdmin = memberActionBlockReason("admin", target("admin"));
    const onOwner = memberActionBlockReason("admin", target("owner"));
    expect(onAdmin).toBeTruthy();
    expect(onOwner).toBeTruthy();
    // A disabled control must say why — that string is the tooltip.
    expect(onAdmin).toContain("chủ sở hữu");
  });

  it("lets an admin act on editors, viewers and on themselves", () => {
    expect(memberActionBlockReason("admin", target("editor"))).toBeNull();
    expect(memberActionBlockReason("admin", target("viewer"))).toBeNull();
    // Leaving the company yourself is allowed even for an admin.
    expect(memberActionBlockReason("admin", target("admin", true))).toBeNull();
  });

  it("blocks editors and viewers outright, and says who to ask", () => {
    const reason = memberActionBlockReason("editor", target("viewer"));
    expect(reason).toContain("Chỉ chủ sở hữu và quản trị viên");
  });

  it("blocks while the operator's own role is unknown", () => {
    expect(memberActionBlockReason(null, target("viewer"))).toBeTruthy();
  });
});

describe("roleChangeBlockReason", () => {
  it("refuses a role the actor cannot grant, naming it", () => {
    const reason = roleChangeBlockReason("admin", { role: "editor", isYou: false }, "admin");
    expect(reason).toContain("Quản trị");
  });

  it("refuses a no-op change", () => {
    expect(roleChangeBlockReason("owner", { role: "editor", isYou: false }, "editor")).toBe(
      "Thành viên này đã ở vai trò đó.",
    );
  });

  it("inherits the ladder: an admin cannot touch an owner at all", () => {
    // Even a role the admin CAN grant is refused when the target is above them.
    expect(roleChangeBlockReason("admin", { role: "owner", isYou: false }, "editor")).toBeTruthy();
  });

  it("allows the changes the ladder permits", () => {
    expect(roleChangeBlockReason("admin", { role: "viewer", isYou: false }, "editor")).toBeNull();
    expect(roleChangeBlockReason("owner", { role: "admin", isYou: false }, "owner")).toBeNull();
  });
});

describe("removeMemberConsequence", () => {
  it("says something different when the operator is removing themselves", () => {
    const other = removeMemberConsequence({ isYou: false });
    const self = removeMemberConsequence({ isYou: true });
    expect(self).toContain("Bạn sẽ mất quyền");
    expect(other).toContain("Người này");
    expect(self).not.toBe(other);
    // Neither may imply the company's data is deleted — it is not.
    expect(self).toContain("không bị xoá");
    expect(other).toContain("không bị xoá");
  });
});
