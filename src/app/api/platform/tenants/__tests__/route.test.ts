import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { summarizeOnboardingSurvey } from "@/core/domain/onboarding-survey-summary";
import type { PlatformTenantListItem } from "@/core/ports/platform-tenant-repo";
import {
  OnboardingSurveySummarySchema,
  PlatformTenantListResponseSchema,
  PlatformTenantSurveySchema,
} from "@/ui/schemas/platform.schema";

/**
 * M3.2 — boundary contract of /api/platform/tenants: support may LIST (the
 * deliberate matrix deviation), only super_admin may CREATE, and the
 * owner-invite token appears exactly once, as a /join URL.
 */

const listTenants = vi.fn();
const createTenant = vi.fn();
const requirePlatformAdmin = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { platformTenants: { listTenants, createTenant }, requirePlatformAdmin },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

// Canonical origin ≠ request host on purpose: the assertion below pins that
// the invite URL follows AUTH_URL, never the incoming request.
vi.stubEnv("AUTH_URL", "https://mysp.example");

const { GET, POST } = await import("../route");

const TENANT = "00000000-0000-0000-0000-00000000d00d";
const TOKEN = "p".repeat(64);

/**
 * Typed with the CORE type on purpose: adding a field to
 * `PlatformTenantListItem` and forgetting the UI mirror makes the drift lock
 * below go red, here, instead of silently disappearing at the boundary.
 */
const LIST_ITEM: PlatformTenantListItem = {
  id: TENANT as PlatformTenantListItem["id"],
  name: "Khách A",
  slug: "khach-a",
  plan: "standard",
  status: "active",
  memberCount: 3,
  createdAt: new Date("2026-08-21T05:00:00Z"),
  survey: {
    sellerKind: "shop_owner",
    // `[]` and `null` in the SAME fixture: the pair that must never collapse.
    currentTools: [],
    channelCount: "4-6",
    focusChannels: null,
    completedAt: new Date("2026-08-26T10:00:00Z"),
  },
};

const getRequest = () => new Request("http://localhost/api/platform/tenants");
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/platform/tenants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "root@mysp.vn", accountId: "acc-root" });
  requirePlatformAdmin.mockResolvedValue({ accountId: "acc-root", platformRole: "super_admin" });
  listTenants.mockResolvedValue({
    items: [LIST_ITEM],
    surveySummary: summarizeOnboardingSurvey([LIST_ITEM.survey]),
  });
  createTenant.mockResolvedValue({
    tenant: { id: TENANT, name: "Khách A", slug: "khach-a", plan: "standard", status: "active" },
    ownerInviteToken: TOKEN,
    inviteExpiresAt: new Date("2026-08-28T05:00:00Z"),
  });
});

// --- Refusals first -----------------------------------------------------------

describe("/api/platform/tenants — refusals", () => {
  it("403s an ordinary operator on GET — no platform role, no list", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("demands only SUPPORT for the list, but SUPER_ADMIN for creation", async () => {
    await GET(getRequest());
    expect(requirePlatformAdmin).toHaveBeenLastCalledWith(expect.anything(), {
      minRole: "support",
    });

    await POST(postRequest({ name: "Khách A" }));
    expect(requirePlatformAdmin).toHaveBeenLastCalledWith(expect.anything(), {
      minRole: "super_admin",
    });
  });

  it("403s support on POST — the guard runs before the body is read", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await POST(postRequest({ name: "Khách A" }));
    expect(response.status).toBe(403);
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("409s SLUG_TAKEN through the shared error shape", async () => {
    createTenant.mockRejectedValue(new AppError("SLUG_TAKEN"));
    const response = await POST(postRequest({ name: "Khách A", slug: "khach-a" }));
    expect(response.status).toBe(409);
  });
});

// --- The handover flow ---------------------------------------------------------

describe("/api/platform/tenants — provisioning", () => {
  it("201s with the owner-invite URL — the token's one appearance", async () => {
    const response = await POST(postRequest({ name: "Khách A" }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.tenant).toMatchObject({ id: TENANT, status: "active" });
    // From AUTH_URL, not from the request's `http://localhost`.
    expect(body.ownerInviteUrl).toBe(`https://mysp.example/join/${TOKEN}`);
    expect(createTenant).toHaveBeenCalledWith({
      name: "Khách A",
      slug: null,
      plan: null,
      actorAccountId: "acc-root",
      actorEmail: "root@mysp.vn",
    });
  });

  it("GET answers the platform list", async () => {
    const response = await GET(getRequest());
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ id: TENANT, memberCount: 3, status: "active" });
  });
});

// --- The anti-drift lock ------------------------------------------------------

/**
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so the
 * platform list contract exists twice. A test is the only thing that can keep
 * the two equal, and this file may import BOTH layers — dependency-cruiser and
 * the ESLint zone rules exempt `*.test.ts`.
 *
 * The comparison is by KEY SET, not by "does it parse": `z.object` STRIPS keys
 * it does not know, so a field added to core and forgotten here would parse
 * happily and then be missing from every screen with nothing to show for it.
 * That failure mode — a mirror that is silently too NARROW — is what this
 * catches.
 */
function keysOf(value: unknown): readonly string[] {
  return typeof value === "object" && value !== null ? Object.keys(value).sort() : [];
}

describe("platform list contract — core and ui must not drift", () => {
  it("parses the real GET answer, key for key, with nothing dropped", async () => {
    const response = await GET(getRequest());
    const body = await response.json();

    const parsed = PlatformTenantListResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(keysOf(parsed.data.items[0])).toEqual(keysOf(body.items[0]));
    expect(keysOf(parsed.data.items[0].survey)).toEqual(keysOf(body.items[0].survey));
    expect(keysOf(parsed.data.surveySummary)).toEqual(keysOf(body.surveySummary));
    for (const field of ["sellerKind", "channelCount", "currentTools", "focusChannels"] as const) {
      expect(keysOf(parsed.data.surveySummary[field])).toEqual(keysOf(body.surveySummary[field]));
    }
  });

  it("mirrors every field of a survey row, including the empty-list answer", () => {
    const wire = JSON.parse(JSON.stringify(LIST_ITEM.survey));
    const parsed = PlatformTenantSurveySchema.safeParse(wire);

    expect(parsed.success).toBe(true);
    expect(keysOf(parsed.success ? parsed.data : null)).toEqual(keysOf(wire));
    // `[]` survives the mirror as `[]`, `null` as `null`.
    expect(parsed.success && parsed.data.currentTools).toEqual([]);
    expect(parsed.success && parsed.data.focusChannels).toBeNull();
  });

  it("mirrors a summary built by the real core summariser, for every breakdown", () => {
    const summary = summarizeOnboardingSurvey(
      [null, { sellerKind: "agency", currentTools: [], channelCount: null, focusChannels: ["tiktok"], completedAt: null }],
      { focusChannels: ["facebook", "tiktok"] },
    );
    const wire = JSON.parse(JSON.stringify(summary));
    const parsed = OnboardingSurveySummarySchema.safeParse(wire);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(keysOf(parsed.data)).toEqual(keysOf(wire));
    expect(keysOf(parsed.data.focusChannels)).toEqual(keysOf(wire.focusChannels));
    expect(keysOf(parsed.data.sellerKind)).toEqual(keysOf(wire.sellerKind));
    // The distinction, end to end: one company skipped, one answered "none".
    expect(parsed.data.currentTools.noAnswer).toBe(1);
    expect(parsed.data.currentTools.answeredNone).toBe(1);
  });

  it("refuses a summary whose list breakdown lost the [] bucket", () => {
    const summary = summarizeOnboardingSurvey([]);
    const wire = JSON.parse(JSON.stringify(summary));
    delete wire.currentTools.answeredNone;

    // If this ever passes, the mirror stopped requiring the number that answers
    // "bao nhiêu người trả lời 'không dùng gì cả'".
    expect(OnboardingSurveySummarySchema.safeParse(wire).success).toBe(false);
  });
});

describe("/api/platform/tenants — the survey aggregate", () => {
  it("GET carries the summary next to the rows it was counted from", async () => {
    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.surveySummary.total).toBe(body.items.length);
    expect(body.surveySummary.sellerKind.byCode).toContainEqual({ code: "shop_owner", count: 1 });
    expect(body.surveySummary.currentTools.answeredNone).toBe(1);
    expect(body.surveySummary.focusChannels.noAnswer).toBe(1);
  });

  it("still lists a company that never answered, with survey null", async () => {
    const untouched = { ...LIST_ITEM, survey: null };
    listTenants.mockResolvedValue({
      items: [untouched],
      surveySummary: summarizeOnboardingSurvey([null]),
    });

    const body = await (await GET(getRequest())).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].survey).toBeNull();
    expect(body.surveySummary.sellerKind.noAnswer).toBe(1);
  });
});
