import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import {
  CHANNEL_COUNTS as CORE_CHANNEL_COUNTS,
  FOCUS_CHANNELS as CORE_FOCUS_CHANNELS,
  SELLER_KINDS as CORE_SELLER_KINDS,
  TOOL_KINDS as CORE_TOOL_KINDS,
} from "@/core/usecases/onboarding-profile";
import {
  CHANNEL_COUNTS as UI_CHANNEL_COUNTS,
  FOCUS_CHANNELS as UI_FOCUS_CHANNELS,
  OnboardingProfilePatchSchema,
  OnboardingProfileSchema,
  SELLER_KINDS as UI_SELLER_KINDS,
  TOOL_KINDS as UI_TOOL_KINDS,
} from "@/ui/schemas/onboarding-profile.schema";

/**
 * Boundary contract of `/api/tenants/onboarding-profile` — and the lock that
 * keeps the survey vocabulary from existing in two versions.
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so the
 * four code lists have to live in both places. A test is the only thing that
 * can make them stay equal: this file is allowed to import BOTH layers because
 * dependency-cruiser and the ESLint zone rules both exempt `*.test.ts`. Add a
 * code to core and forget the mirror and this goes red here, not in production
 * where the answer would be silently refused at the boundary.
 */

const getOnboardingProfile = vi.fn();
const saveOnboardingProfile = vi.fn();
const completeOnboarding = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getOnboardingProfile, saveOnboardingProfile, completeOnboarding, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, PATCH, POST } = await import("../route");

const TENANT = "00000000-0000-0000-0000-000000000001";
const URL_ = "http://localhost/api/tenants/onboarding-profile";

const PROFILE = {
  sellerKind: "shop_owner",
  currentTools: ["meta_business_suite"],
  channelCount: "4-6",
  focusChannels: [],
  completedAt: null,
};

const read = () => new Request(URL_);
const write = (body: unknown) =>
  new Request(URL_, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const finish = () => new Request(URL_, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@x.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  getOnboardingProfile.mockResolvedValue(PROFILE);
  saveOnboardingProfile.mockResolvedValue(PROFILE);
  completeOnboarding.mockResolvedValue({ ...PROFILE, completedAt: new Date("2026-08-26T10:00:00.000Z") });
});

// --- The anti-drift lock ----------------------------------------------------

describe("survey vocabulary — core and ui must not drift", () => {
  it("carries the same seller kinds in the same order", () => {
    expect([...UI_SELLER_KINDS]).toEqual([...CORE_SELLER_KINDS]);
  });

  it("carries the same tool kinds in the same order", () => {
    expect([...UI_TOOL_KINDS]).toEqual([...CORE_TOOL_KINDS]);
  });

  it("carries the same page-count buckets in the same order", () => {
    expect([...UI_CHANNEL_COUNTS]).toEqual([...CORE_CHANNEL_COUNTS]);
  });

  it("carries the same focus channels in the same order", () => {
    expect([...UI_FOCUS_CHANNELS]).toEqual([...CORE_FOCUS_CHANNELS]);
  });

  it("accepts every code core defines — a missing mirror entry is a 400 nobody could explain", () => {
    for (const sellerKind of CORE_SELLER_KINDS) {
      expect(OnboardingProfilePatchSchema.safeParse({ sellerKind }).success).toBe(true);
    }
    for (const channelCount of CORE_CHANNEL_COUNTS) {
      expect(OnboardingProfilePatchSchema.safeParse({ channelCount }).success).toBe(true);
    }
    expect(OnboardingProfilePatchSchema.safeParse({ currentTools: [...CORE_TOOL_KINDS] }).success).toBe(true);
    expect(OnboardingProfilePatchSchema.safeParse({ focusChannels: [...CORE_FOCUS_CHANNELS] }).success).toBe(true);
  });

  it("reads back a response built from core codes", () => {
    const wire = {
      sellerKind: CORE_SELLER_KINDS[0],
      currentTools: [...CORE_TOOL_KINDS],
      channelCount: CORE_CHANNEL_COUNTS[0],
      focusChannels: [...CORE_FOCUS_CHANNELS],
      completedAt: "2026-08-26T10:00:00.000Z",
    };
    expect(OnboardingProfileSchema.safeParse(wire).success).toBe(true);
  });
});

// --- Refusals first ---------------------------------------------------------

describe("/api/tenants/onboarding-profile — refusals", () => {
  it("401s a GET without a session and never reaches the usecase", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await GET(read());
    expect(response.status).toBe(401);
    expect(getOnboardingProfile).not.toHaveBeenCalled();
  });

  it("401s a PATCH without a session and never reads the body", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await PATCH(write({ sellerKind: "agency" }));
    expect(response.status).toBe(401);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("403s an editor writing — the survey describes the company, not the seat", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN", { context: { tenant_id: TENANT, role: "editor" } }));
    const response = await PATCH(write({ sellerKind: "agency" }));
    expect(response.status).toBe(403);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("403s an editor reading", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN", { context: { tenant_id: TENANT, role: "editor" } }));
    const response = await GET(read());
    expect(response.status).toBe(403);
    expect(getOnboardingProfile).not.toHaveBeenCalled();
  });

  it("403s an editor finishing", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN", { context: { tenant_id: TENANT, role: "editor" } }));
    const response = await POST(finish());
    expect(response.status).toBe(403);
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("409s when no company is selected", async () => {
    requireTenant.mockRejectedValue(new AppError("TENANT_NOT_SELECTED"));
    const response = await GET(read());
    expect(response.status).toBe(409);
  });

  it("400s a code nobody defined instead of storing it", async () => {
    const response = await PATCH(write({ sellerKind: "space_pirate" }));
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("400s one bad code inside an otherwise valid list", async () => {
    const response = await PATCH(write({ currentTools: ["meta_business_suite", "myspace"] }));
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("400s a key nobody defined rather than dropping it", async () => {
    const response = await PATCH(write({ sellerKind: "agency", favouriteColour: "blue" }));
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("400s an empty patch — the client must skip by sending null, or not call at all", async () => {
    const response = await PATCH(write({}));
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON", async () => {
    const bad = new Request(URL_, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const response = await PATCH(bad);
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("400s completedAt sent through PATCH — finishing goes through POST", async () => {
    const response = await PATCH(write({ completedAt: "2026-08-26T10:00:00.000Z" }));
    expect(response.status).toBe(400);
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
  });

  it("keeps the shared error shape when the usecase itself fails", async () => {
    getOnboardingProfile.mockRejectedValue(new AppError("DB_ERROR", { context: { tenant_id: TENANT } }));
    const response = await GET(read());
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("DB_ERROR");
    expect(typeof body.message).toBe("string");
  });
});

// --- The claim --------------------------------------------------------------

describe("/api/tenants/onboarding-profile — authorisation claim", () => {
  it("asks for at least admin on every verb", async () => {
    await GET(read());
    await PATCH(write({ sellerKind: "agency" }));
    await POST(finish());

    for (const call of requireTenant.mock.calls) {
      const claim = call[2] as { tier?: string; minRole?: string };
      expect(claim).toMatchObject({ minRole: "admin" });
    }
  });

  it("takes the tenant from the authorised context, never from the body", async () => {
    await PATCH(
      new Request(URL_, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sellerKind: "agency", tenantId: "11111111-1111-1111-1111-111111111111" }),
      }),
    );
    // `tenantId` in the body is an unknown key, so the request is refused
    // outright rather than quietly ignored.
    expect(saveOnboardingProfile).not.toHaveBeenCalled();

    await PATCH(write({ sellerKind: "agency" }));
    expect(saveOnboardingProfile).toHaveBeenCalledWith({
      tenantId: TENANT,
      patch: { sellerKind: "agency" },
    });
  });
});

// --- Happy path -------------------------------------------------------------

describe("/api/tenants/onboarding-profile — happy path", () => {
  it("GET answers a shape the UI schema accepts", async () => {
    const response = await GET(read());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(OnboardingProfileSchema.safeParse(body).success).toBe(true);
  });

  it("GET serialises completedAt as an ISO string, not a Date", async () => {
    getOnboardingProfile.mockResolvedValue({ ...PROFILE, completedAt: new Date("2026-08-26T10:00:00.000Z") });
    const response = await GET(read());
    const body = (await response.json()) as { completedAt: unknown };
    expect(body.completedAt).toBe("2026-08-26T10:00:00.000Z");
  });

  it("PATCH forwards null as a clear, not as an absent key", async () => {
    await PATCH(write({ sellerKind: null }));
    expect(saveOnboardingProfile).toHaveBeenCalledWith({ tenantId: TENANT, patch: { sellerKind: null } });
  });

  it("PATCH forwards an empty list as an empty list", async () => {
    await PATCH(write({ focusChannels: [] }));
    expect(saveOnboardingProfile).toHaveBeenCalledWith({ tenantId: TENANT, patch: { focusChannels: [] } });
  });

  it("POST finishes the survey and answers the stamped profile", async () => {
    const response = await POST(finish());
    expect(response.status).toBe(200);
    expect(completeOnboarding).toHaveBeenCalledWith({ tenantId: TENANT });
    const body = (await response.json()) as { completedAt: unknown };
    expect(body.completedAt).toBe("2026-08-26T10:00:00.000Z");
  });
});
