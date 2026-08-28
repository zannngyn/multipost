import { describe, expect, it } from "vitest";

import {
  CreateTenantFormSchema,
  CreateTenantResponseSchema,
  JoinInviteFormSchema,
  JoinTenantResponseSchema,
  SLUG_MAX_LENGTH,
  isCreateTenantField,
  joinSuccessMessage,
  parseInviteToken,
  slugify,
} from "../tenant-onboarding.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Three rules must hold:
 *  - a company name in Vietnamese must produce a usable URL segment, tone marks
 *    and đ included — otherwise the auto-preview is worse than no preview;
 *  - what someone pastes ("the whole link") must be understood, because that is
 *    what is actually in a clipboard;
 *  - the answers that decide WHICH company the operator is now in must fail
 *    loudly rather than half-parse.
 */

describe("slugify", () => {
  it("turns a Vietnamese company name into a URL segment", () => {
    expect(slugify("Nhà Xe An Anh")).toBe("nha-xe-an-anh");
    expect(slugify("Đồng Tâm")).toBe("dong-tam");
    expect(slugify("MYSP — Hàng Thiết Kế")).toBe("mysp-hang-thiet-ke");
  });

  it("never leaves a dangling dash, including after the length cut", () => {
    expect(slugify("  --Nhà Xe--  ")).toBe("nha-xe");
    expect(slugify("a".repeat(SLUG_MAX_LENGTH - 1) + " b")).not.toMatch(/-$/);
    expect(slugify("Công ty &&& 2026")).toBe("cong-ty-2026");
  });

  it("returns an empty string when there is nothing to slug", () => {
    // The form then shows its own "cần ít nhất 3 ký tự" message; a preview that
    // invents a value would be worse than an empty box.
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });
});

describe("CreateTenantFormSchema", () => {
  const base = { name: "Nhà Xe An Anh", slug: "nha-xe-an-anh" };

  it("accepts a normal company", () => {
    expect(CreateTenantFormSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a name that is only whitespace", () => {
    expect(CreateTenantFormSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("rejects a slug with characters a URL segment cannot hold", () => {
    for (const slug of ["Nha Xe", "nha_xe", "nha--xe-", "-nha-xe", "nhà-xe"]) {
      expect(CreateTenantFormSchema.safeParse({ ...base, slug }).success).toBe(false);
    }
  });

  it("lowercases a slug typed in capitals instead of refusing it", () => {
    const parsed = CreateTenantFormSchema.safeParse({ ...base, slug: "NHA-XE" });
    expect(parsed.success && parsed.data.slug).toBe("nha-xe");
  });

  it("names the fields the server may report issues on", () => {
    expect(isCreateTenantField("slug")).toBe(true);
    expect(isCreateTenantField("plan")).toBe(false);
  });
});

describe("parseInviteToken", () => {
  it("reads the token out of a pasted link", () => {
    expect(parseInviteToken("https://mysp.vn/join/abc123XYZ")).toBe("abc123XYZ");
    expect(parseInviteToken("/join/abc123XYZ")).toBe("abc123XYZ");
    // Mailers append tracking parameters and anchors.
    expect(parseInviteToken("https://mysp.vn/join/abc123XYZ?utm_source=mail#top")).toBe(
      "abc123XYZ",
    );
  });

  it("accepts a bare token", () => {
    expect(parseInviteToken("  abc123XYZ  ")).toBe("abc123XYZ");
  });

  it("decodes a token that travelled percent-encoded", () => {
    expect(parseInviteToken("https://mysp.vn/join/abc%2D123")).toBe("abc-123");
  });

  it("returns null for anything that is not a token", () => {
    expect(parseInviteToken("")).toBeNull();
    expect(parseInviteToken("   ")).toBeNull();
    expect(parseInviteToken("mời bạn vào công ty nhé")).toBeNull();
    // Too short to be a token — better a field error than a pointless 404.
    expect(parseInviteToken("abc")).toBeNull();
  });
});

describe("JoinInviteFormSchema", () => {
  it("accepts a link and a bare token", () => {
    expect(JoinInviteFormSchema.safeParse({ invite: "https://mysp.vn/join/abc123XYZ" }).success).toBe(
      true,
    );
    expect(JoinInviteFormSchema.safeParse({ invite: "abc123XYZ" }).success).toBe(true);
  });

  it("refuses an empty box and a pasted sentence, with different messages", () => {
    const empty = JoinInviteFormSchema.safeParse({ invite: "  " });
    const prose = JoinInviteFormSchema.safeParse({ invite: "vào công ty của mình nhé" });
    expect(empty.success).toBe(false);
    expect(prose.success).toBe(false);
    expect(empty.success === false && empty.error.issues[0]?.message).not.toBe(
      prose.success === false ? prose.error.issues[0]?.message : "",
    );
  });
});

describe("response contracts", () => {
  const tenant = {
    id: "00000000-0000-0000-0000-000000000009",
    name: "Nhà Xe An Anh",
    slug: "nha-xe-an-anh",
    plan: "free",
  };

  /** Recorded from the running API — the real answer, field for field. */
  it("accepts the create answer the API returns, shaped like /api/me", () => {
    const parsed = CreateTenantResponseSchema.safeParse({
      tenant: {
        id: "63d4f1f6-0308-44f5-b06a-48a5637984ff",
        name: "Cong ty thu",
        slug: "cong-ty-thu",
        plan: "standard",
        role: "owner",
      },
      activeTenantId: "63d4f1f6-0308-44f5-b06a-48a5637984ff",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tenant.id).toBe("63d4f1f6-0308-44f5-b06a-48a5637984ff");
  });

  it("rejects a company with no id — nothing downstream could address it", () => {
    expect(
      CreateTenantResponseSchema.safeParse({
        tenant: { name: "X", slug: null, plan: "free", role: "owner" },
        activeTenantId: "t-1",
      }).success,
    ).toBe(false);
    // The old `tenantId` spelling is no longer a company id, and must not
    // quietly pass as one.
    expect(
      CreateTenantResponseSchema.safeParse({
        tenant: { tenantId: "t-1", name: "X", slug: null, plan: "free", role: "owner" },
        activeTenantId: "t-1",
      }).success,
    ).toBe(false);
  });

  it("accepts the create answer, which carries the owner role inside tenant", () => {
    const parsed = CreateTenantResponseSchema.safeParse({
      tenant: { ...tenant, role: "owner" },
      activeTenantId: tenant.id,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tenant.role).toBe("owner");
  });

  it("rejects a create answer with no active company — the UI would guess", () => {
    expect(
      CreateTenantResponseSchema.safeParse({ tenant: { ...tenant, role: "owner" } }).success,
    ).toBe(false);
  });

  it("accepts the join answer, whose role sits next to the company", () => {
    const parsed = JoinTenantResponseSchema.safeParse({ tenant, role: "editor" });
    expect(parsed.success).toBe(true);
    // Absent means "vừa vào", not "đã ở trong" — the two get different copy.
    expect(parsed.success && parsed.data.alreadyMember).toBe(false);
  });

  it("keeps the alreadyMember flag when the server sends it", () => {
    const parsed = JoinTenantResponseSchema.safeParse({
      tenant,
      role: "viewer",
      alreadyMember: true,
    });
    expect(parsed.success && parsed.data.alreadyMember).toBe(true);
  });

  it("rejects a role the UI cannot render", () => {
    expect(JoinTenantResponseSchema.safeParse({ tenant, role: "superuser" }).success).toBe(false);
  });
});

describe("joinSuccessMessage", () => {
  // `role` sits NEXT TO the company on this path, so the company itself carries
  // none — which is why it is optional on the shared shape.
  const tenant = {
    id: "t-9",
    name: "Nhà Xe An Anh",
    slug: null,
    plan: "free",
  };

  it("tells 'vừa vào' apart from 'vốn đã là thành viên'", () => {
    const joined = joinSuccessMessage(
      { tenant, role: "editor", alreadyMember: false },
      "Biên tập",
    );
    const already = joinSuccessMessage(
      { tenant, role: "editor", alreadyMember: true },
      "Biên tập",
    );
    expect(joined).toContain("Bạn đã vào Nhà Xe An Anh");
    expect(already).toContain("đã là thành viên");
    expect(joined).not.toBe(already);
  });
});
