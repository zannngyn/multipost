import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/ui/services/api-error";
import {
  completeOnboarding,
  fetchOnboardingProfile,
  saveOnboardingStep,
} from "@/ui/services/onboarding-profile.api";
import { ensureDefaultTenant } from "@/ui/services/tenant-onboarding.api";

/**
 * WHAT ENDS UP ON THE WIRE for the onboarding survey.
 *
 * Every assertion here defends a rule the route enforces and no type can:
 *   - `PATCH {}` answers 400 ("Patch must carry at least one answer"), so the
 *     empty patch must die on this side, before a round trip and before a red
 *     box the operator cannot act on;
 *   - `null` must reach the server as `null`, not as `[]` or `""` — the three
 *     mean "bỏ qua", "không dùng cái nào" and "invalid" respectively;
 *   - `POST` carries NO body: finishing says nothing beyond "we got here";
 *   - the verb matters. A `PUT` where the route exports `PATCH` is a 405 that
 *     only shows up at runtime.
 */

const fetchMock = vi.fn();

function callAt(index: number): [string, RequestInit] {
  return fetchMock.mock.calls[index] as [string, RequestInit];
}

const PROFILE = {
  sellerKind: "shop_owner",
  currentTools: ["meta_business_suite"],
  channelCount: "4-6",
  focusChannels: ["facebook"],
  completedAt: null,
};

function respondWith(payload: unknown, status = 200) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  respondWith(PROFILE);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveOnboardingStep", () => {
  it("PATCHes the one answer it was given", async () => {
    await saveOnboardingStep({ sellerKind: "shop_owner" });

    const [path, init] = callAt(0);
    expect(path).toBe("/api/tenants/onboarding-profile");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ sellerKind: "shop_owner" });
  });

  it("sends null as null — that is what 'Bỏ qua' means", async () => {
    await saveOnboardingStep({ currentTools: null });

    const body = JSON.parse(String(callAt(0)[1].body)) as Record<string, unknown>;
    expect("currentTools" in body).toBe(true);
    expect(body.currentTools).toBeNull();
  });

  it("sends an empty list as a list — it is an answer, not a skip", async () => {
    await saveOnboardingStep({ focusChannels: [] });

    const body = JSON.parse(String(callAt(0)[1].body)) as Record<string, unknown>;
    expect(body.focusChannels).toEqual([]);
  });

  it("refuses an EMPTY patch without touching the network", async () => {
    // The route answers 400 for this. A local refusal keeps the flow from
    // showing a server error for a request it should never have made.
    await expect(saveOnboardingStep({})).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a key the contract does not know", async () => {
    await expect(
      // A typo'd field must not look like a successful save.
      saveOnboardingStep({ sellerKinds: "shop_owner" } as never),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a code outside the vocabulary", async () => {
    await expect(saveOnboardingStep({ sellerKind: "MEGA_CORP" } as never)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("completeOnboarding", () => {
  it("POSTs with no body at all", async () => {
    respondWith({ ...PROFILE, completedAt: "2026-08-26T02:00:00.000Z" });

    const finished = await completeOnboarding();

    const [path, init] = callAt(0);
    expect(path).toBe("/api/tenants/onboarding-profile");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(finished.completedAt).toBe("2026-08-26T02:00:00.000Z");
  });
});

describe("fetchOnboardingProfile", () => {
  it("reads the answers back with their three states intact", async () => {
    respondWith({ ...PROFILE, currentTools: [], channelCount: null });

    const profile = await fetchOnboardingProfile();

    expect(profile.currentTools).toEqual([]);
    expect(profile.channelCount).toBeNull();
    expect(callAt(0)[1].method).toBe("GET");
  });

  it("rejects a payload that is not the contract", async () => {
    respondWith({ sellerKind: "shop_owner" });
    await expect(fetchOnboardingProfile()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("ensureDefaultTenant", () => {
  it("POSTs with no body and reports whether a company was created", async () => {
    respondWith({ tenantId: "00000000-0000-0000-0000-000000000001", wasCreated: true }, 201);

    const result = await ensureDefaultTenant();

    const [path, init] = callAt(0);
    expect(path).toBe("/api/tenants/ensure-default");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(result).toEqual({
      tenantId: "00000000-0000-0000-0000-000000000001",
      wasCreated: true,
    });
  });

  it("reads a 200 as 'the account already had one'", async () => {
    respondWith({ tenantId: "00000000-0000-0000-0000-000000000001", wasCreated: false }, 200);

    await expect(ensureDefaultTenant()).resolves.toEqual({
      tenantId: "00000000-0000-0000-0000-000000000001",
      wasCreated: false,
    });
  });
});
