import { describe, expect, it } from "vitest";

import {
  CreatePlatformTenantFormSchema,
  CreatePlatformTenantResponseSchema,
  OnboardingSurveySummarySchema,
  PlatformTenantListResponseSchema,
  PlatformTenantSurveySchema,
  SUSPEND_REASON_MIN,
  TenantStatusReasonFormSchema,
  canAdministerPlatform,
  canViewPlatform,
  isCreatePlatformTenantField,
  isInternalTenant,
  platformActionBlockReason,
  platformRoleLabel,
  SUPPORT_PURPOSE_MIN,
  StartSupportSessionFormSchema,
  StartSupportSessionResponseSchema,
  activateConsequence,
  suspendConsequence,
} from "../platform.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Two rules must never regress:
 *  - the PLATFORM ladder (support reads, super_admin acts) — client-side it is
 *    only UX, but a screen that offers what the server refuses teaches people
 *    to distrust the buttons;
 *  - the owner invite url is a credential: a non-http scheme must fail the
 *    parse instead of reaching an input and a clipboard.
 */

const SURVEY_ROW = {
  sellerKind: "shop_owner",
  currentTools: ["meta_business_suite"],
  channelCount: "4-6",
  focusChannels: [],
  completedAt: "2026-08-26T10:00:00.000Z",
};

const TENANT_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "MysP Nội Bộ",
  slug: "demo",
  plan: "internal",
  status: "active",
  memberCount: 5,
  createdAt: "2026-08-19T10:13:28.916Z",
  survey: SURVEY_ROW,
};

const EMPTY_BREAKDOWN = { total: 0, answered: 0, noAnswer: 0, unreadable: 0, byCode: [] };
const EMPTY_MULTI = { ...EMPTY_BREAKDOWN, answeredNone: 0, unreadableVotes: 0, votes: 0 };
const SUMMARY = {
  total: 1,
  completed: 1,
  notCompleted: 0,
  sellerKind: { ...EMPTY_BREAKDOWN, total: 1, answered: 1, byCode: [{ code: "shop_owner", count: 1 }] },
  channelCount: { ...EMPTY_BREAKDOWN, total: 1, answered: 1, byCode: [{ code: "4-6", count: 1 }] },
  currentTools: { ...EMPTY_MULTI, total: 1, answered: 1, votes: 1, byCode: [{ code: "meta_business_suite", count: 1 }] },
  focusChannels: { ...EMPTY_MULTI, total: 1, answeredNone: 1 },
};

const listBody = (items: unknown[]) => ({ items, surveySummary: SUMMARY });

describe("PlatformTenantListResponseSchema", () => {
  it("accepts a company list", () => {
    expect(PlatformTenantListResponseSchema.safeParse(listBody([TENANT_ROW])).success).toBe(true);
  });

  it("accepts a company with no slug and no members yet", () => {
    const parsed = PlatformTenantListResponseSchema.safeParse(
      listBody([{ ...TENANT_ROW, slug: null, memberCount: 0 }]),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts a company that never answered the survey — most of them have not", () => {
    // LEFT JOIN: `survey: null` is the ordinary case, not an error case.
    const parsed = PlatformTenantListResponseSchema.safeParse(
      listBody([{ ...TENANT_ROW, survey: null }]),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses a list with no summary — the strip would render numbers it invented", () => {
    expect(PlatformTenantListResponseSchema.safeParse({ items: [TENANT_ROW] }).success).toBe(false);
  });

  it("rejects a status the UI cannot render", () => {
    // "archived" would fall through every branch and render as nothing, which
    // on THIS screen means a company nobody can tell is off.
    expect(
      PlatformTenantListResponseSchema.safeParse({ items: [{ ...TENANT_ROW, status: "archived" }] })
        .success,
    ).toBe(false);
  });

  it("keeps the survey row on the parsed company, not just in the summary", () => {
    const parsed = PlatformTenantListResponseSchema.safeParse(listBody([TENANT_ROW]));
    expect(parsed.success && parsed.data.items[0].survey).toEqual(SURVEY_ROW);
  });

  it("rejects a negative member count and an unparseable createdAt", () => {
    expect(
      PlatformTenantListResponseSchema.safeParse({ items: [{ ...TENANT_ROW, memberCount: -1 }] })
        .success,
    ).toBe(false);
    expect(
      PlatformTenantListResponseSchema.safeParse({ items: [{ ...TENANT_ROW, createdAt: "hôm qua" }] })
        .success,
    ).toBe(false);
  });
});

describe("CreatePlatformTenantResponseSchema", () => {
  const created = {
    tenant: { id: "t-9", name: "Nhà Xe An Anh", slug: "an-anh", plan: "standard", status: "active" },
    ownerInviteUrl: "https://mysp.vn/join/abc123",
    inviteExpiresAt: "2026-08-27T05:12:47.308Z",
  };

  it("accepts the answer the contract describes", () => {
    expect(CreatePlatformTenantResponseSchema.safeParse(created).success).toBe(true);
  });

  it("refuses an owner link that is not http(s)", () => {
    for (const ownerInviteUrl of ["javascript:alert(1)", "data:text/html,<script>"]) {
      expect(CreatePlatformTenantResponseSchema.safeParse({ ...created, ownerInviteUrl }).success).toBe(
        false,
      );
    }
  });

  it("refuses an answer with no owner link — the whole point of the call", () => {
    const { ownerInviteUrl: _url, ...withoutUrl } = created;
    expect(CreatePlatformTenantResponseSchema.safeParse(withoutUrl).success).toBe(false);
  });
});

describe("the platform ladder", () => {
  it("lets both roles look, and only super_admin act", () => {
    expect(canViewPlatform("support")).toBe(true);
    expect(canViewPlatform("super_admin")).toBe(true);
    expect(canViewPlatform(null)).toBe(false);

    expect(canAdministerPlatform("support")).toBe(false);
    expect(canAdministerPlatform("super_admin")).toBe(true);
    expect(canAdministerPlatform(null)).toBe(false);
  });

  it("gives support its own sentence, not a generic refusal", () => {
    const support = platformActionBlockReason("support");
    const outsider = platformActionBlockReason(null);
    expect(support).toContain("chỉ xem");
    expect(outsider).not.toBe(support);
    expect(platformActionBlockReason("super_admin")).toBeNull();
  });

  it("names every role, including no role at all", () => {
    expect(platformRoleLabel(null)).toBe("Không có quyền nền tảng");
    expect(platformRoleLabel("support")).toContain("chỉ xem");
    expect(platformRoleLabel("super_admin")).toBeTruthy();
  });
});

describe("isInternalTenant", () => {
  it("marks MYSP's own workspace whatever the casing", () => {
    expect(isInternalTenant({ plan: "internal" })).toBe(true);
    expect(isInternalTenant({ plan: " Internal " })).toBe(true);
    expect(isInternalTenant({ plan: "standard" })).toBe(false);
  });
});

describe("CreatePlatformTenantFormSchema", () => {
  const base = { name: "Nhà Xe An Anh", slug: "", plan: "" };

  it("needs only a name — slug and plan are the server's defaults", () => {
    expect(CreatePlatformTenantFormSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a name that is only whitespace", () => {
    expect(CreatePlatformTenantFormSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
  });

  it("validates a slug only when one was typed", () => {
    expect(CreatePlatformTenantFormSchema.safeParse({ ...base, slug: "an-anh" }).success).toBe(true);
    expect(CreatePlatformTenantFormSchema.safeParse({ ...base, slug: "An Anh" }).success).toBe(false);
    expect(CreatePlatformTenantFormSchema.safeParse({ ...base, slug: "" }).success).toBe(true);
  });

  it("names the fields the server may report issues on", () => {
    expect(isCreatePlatformTenantField("slug")).toBe(true);
    expect(isCreatePlatformTenantField("status")).toBe(false);
  });
});

describe("TenantStatusReasonFormSchema", () => {
  // The SAME rule guards suspend and activate: the server asks for a reason in
  // both directions (`_lib/set-status.ts`), so an "activate" with an empty body
  // would come back 400.
  it("refuses a reason too short to answer 'vì sao' months later", () => {
    expect(TenantStatusReasonFormSchema.safeParse({ reason: "test" }).success).toBe(false);
    expect(TenantStatusReasonFormSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(
      TenantStatusReasonFormSchema.safeParse({ reason: "x".repeat(SUSPEND_REASON_MIN) }).success,
    ).toBe(true);
  });

  it("trims before measuring, so padding cannot buy the minimum", () => {
    const padded = { reason: `  ${"x".repeat(SUSPEND_REASON_MIN - 4)}   ` };
    expect(TenantStatusReasonFormSchema.safeParse(padded).success).toBe(false);
  });
});

describe("consequences", () => {
  it("says what mở khoá does, in the other direction", () => {
    expect(activateConsequence({ name: "Nhà Xe An Anh", memberCount: 7 })).toContain(
      "vào lại được ngay",
    );
  });

  it("counts the people who lose access, and says data survives", () => {
    const many = suspendConsequence({ name: "Nhà Xe An Anh", memberCount: 7 });
    expect(many).toContain("Cả 7 thành viên");
    expect(many).toContain("không bị xoá");
    // A company with nobody in it still loses its scheduled posts.
    expect(suspendConsequence({ name: "Công ty mới", memberCount: 0 })).toContain("Mọi thành viên");
  });
});

describe("support sessions (M3.3)", () => {
  it("refuses a purpose too short for the customer to make sense of", () => {
    // The line lands in the CUSTOMER's audit trail; "xem thu" answers nothing.
    expect(StartSupportSessionFormSchema.safeParse({ purpose: "xem thu" }).success).toBe(false);
    expect(StartSupportSessionFormSchema.safeParse({ purpose: "   " }).success).toBe(false);
    expect(
      StartSupportSessionFormSchema.safeParse({ purpose: "x".repeat(SUPPORT_PURPOSE_MIN) }).success,
    ).toBe(true);
  });

  it("accepts the answer the contract describes", () => {
    const parsed = StartSupportSessionResponseSchema.safeParse({
      sessionId: "s-1",
      tenant: { id: "t-2", name: "Nha Xe An Anh", slug: "an-anh" },
      expiresAt: "2026-08-20T11:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an answer with no expiry — a session that never visibly ends", () => {
    expect(
      StartSupportSessionResponseSchema.safeParse({
        sessionId: "s-1",
        tenant: { id: "t-2", name: "X", slug: null },
      }).success,
    ).toBe(false);
  });
});

// --- The survey mirror ------------------------------------------------------

describe("PlatformTenantSurveySchema", () => {
  it("keeps [] and null apart — the whole feature rests on this", () => {
    const parsed = PlatformTenantSurveySchema.safeParse({
      sellerKind: null,
      currentTools: [],
      channelCount: null,
      focusChannels: null,
      completedAt: null,
    });

    expect(parsed.success).toBe(true);
    // "không chọn gì" (answered) and "bỏ qua" (not answered) must not arrive as
    // the same value, or the count of skips becomes fiction.
    expect(parsed.success && parsed.data.currentTools).toEqual([]);
    expect(parsed.success && parsed.data.focusChannels).toBeNull();
  });

  it("accepts a code this bundle has never heard of", () => {
    // A company answered before an option was retired. Under z.enum this one
    // row would fail the parse and blank the WHOLE platform table.
    const parsed = PlatformTenantSurveySchema.safeParse({
      ...SURVEY_ROW,
      sellerKind: "retired_in_2027",
      focusChannels: ["a_channel_added_later"],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a blank code — an empty string is corrupt data, not 'bỏ qua'", () => {
    expect(PlatformTenantSurveySchema.safeParse({ ...SURVEY_ROW, sellerKind: "" }).success).toBe(false);
    expect(
      PlatformTenantSurveySchema.safeParse({ ...SURVEY_ROW, currentTools: [""] }).success,
    ).toBe(false);
  });

  it("refuses a completedAt that is not a real moment", () => {
    expect(
      PlatformTenantSurveySchema.safeParse({ ...SURVEY_ROW, completedAt: "hôm qua" }).success,
    ).toBe(false);
  });
});

describe("OnboardingSurveySummarySchema", () => {
  it("accepts the shape the server sends", () => {
    expect(OnboardingSurveySummarySchema.safeParse(SUMMARY).success).toBe(true);
  });

  it("requires BOTH no-answer buckets on a many-choice question", () => {
    for (const missing of ["noAnswer", "answeredNone"] as const) {
      const broken = { ...SUMMARY, currentTools: { ...SUMMARY.currentTools } };
      delete (broken.currentTools as Record<string, unknown>)[missing];
      expect(OnboardingSurveySummarySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects a negative tally — a count that cannot exist must not reach a screen", () => {
    const broken = {
      ...SUMMARY,
      sellerKind: { ...SUMMARY.sellerKind, byCode: [{ code: "agency", count: -1 }] },
    };
    expect(OnboardingSurveySummarySchema.safeParse(broken).success).toBe(false);
  });

  it("keeps a zero tally — an offered option nobody picked is a real answer", () => {
    const zeroed = {
      ...SUMMARY,
      focusChannels: { ...SUMMARY.focusChannels, byCode: [{ code: "instagram", count: 0 }] },
    };
    const parsed = OnboardingSurveySummarySchema.safeParse(zeroed);
    expect(parsed.success && parsed.data.focusChannels.byCode[0].count).toBe(0);
  });
});
