import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { Clock, Logger } from "@/core/ports/infra";
import type { OnboardingProfile, TenantProfileRepo } from "@/core/ports/tenant-profile";

import {
  CHANNEL_COUNTS,
  FOCUS_CHANNELS,
  SELLER_KINDS,
  TOOL_KINDS,
  makeCompleteOnboarding,
  makeGetOnboardingProfile,
  makeSaveOnboardingProfile,
} from "../onboarding-profile";

/**
 * The onboarding survey (E10 — spec §6/§8). The DB deliberately constrains no
 * vocabulary (no enum, no check), so THIS is the only gate a write passes
 * through: a code nobody defined must be refused here or it lands in the table
 * and every later reader has to guess what it meant.
 *
 * The three-state contract is the other thing under test — absent / null / value
 * are three different facts, and a per-step autosave that collapses them wipes
 * the answers to the steps before it.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

const EMPTY: OnboardingProfile = {
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
  completedAt: null,
};

function silentLogger(): Logger {
  const self: Logger = {
    child: () => self,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return self;
}

function fixedClock(iso = "2026-08-26T10:00:00.000Z"): Clock {
  return { now: () => new Date(iso), nowMs: () => new Date(iso).getTime() };
}

function harness(stored: OnboardingProfile | null = null) {
  const profiles = {
    get: vi.fn(async () => stored),
    upsert: vi.fn(async (_tenantId, patch) => ({ ...EMPTY, ...(stored ?? {}), ...patch })),
  } as unknown as TenantProfileRepo & {
    get: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };

  const logger = silentLogger();
  return {
    profiles,
    getProfile: makeGetOnboardingProfile({ profiles, logger }),
    saveProfile: makeSaveOnboardingProfile({ profiles, logger }),
    complete: makeCompleteOnboarding({ profiles, clock: fixedClock(), logger }),
  };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return AppError.is(error) ? error.code : `not-an-AppError:${String(error)}`;
  }
  return "did-not-throw";
}

// --- The vocabulary itself --------------------------------------------------

describe("onboarding survey vocabulary", () => {
  it("keeps the four lists free of duplicates — a duplicate would render twice", () => {
    for (const list of [SELLER_KINDS, TOOL_KINDS, CHANNEL_COUNTS, FOCUS_CHANNELS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("stores stable codes, never the Vietnamese labels shown on screen", () => {
    for (const list of [SELLER_KINDS, TOOL_KINDS, CHANNEL_COUNTS, FOCUS_CHANNELS]) {
      for (const code of list) {
        expect(code).toMatch(/^[a-z0-9_+-]+$/);
      }
    }
  });
});

// --- Refusals first (CLAUDE.md technical rule 1) ----------------------------

describe("saveOnboardingProfile — refusals", () => {
  it("refuses a tenant id that is not a UUID, without touching the repo", async () => {
    const { saveProfile, profiles } = harness();
    await expect(codeOf(saveProfile({ tenantId: testTenantId("nope"), patch: { sellerKind: "agency" } }))).resolves.toBe(
      "INVALID_INPUT",
    );
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("refuses an EMPTY patch — it asserts nothing and would read as a saved step", async () => {
    const { saveProfile, profiles } = harness();
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: {} }))).resolves.toBe("INVALID_INPUT");
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("refuses a patch that is not an object at all", async () => {
    const { saveProfile } = harness();
    await expect(
      codeOf(saveProfile({ tenantId: TENANT, patch: null as unknown as Record<string, never> })),
    ).resolves.toBe("INVALID_INPUT");
  });

  it("refuses a key nobody defined instead of dropping it silently", async () => {
    const { saveProfile, profiles } = harness();
    const patch = { sellerKind: "agency", favouriteColour: "blue" } as Record<string, unknown>;
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch }))).resolves.toBe("INVALID_INPUT");
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("refuses a sellerKind outside SELLER_KINDS — the DB has no enum to catch it", async () => {
    const { saveProfile, profiles } = harness();
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { sellerKind: "space_pirate" } }))).resolves.toBe(
      "INVALID_INPUT",
    );
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("never repairs a near-miss code into the closest valid one", async () => {
    const { saveProfile, profiles } = harness();
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { sellerKind: "AGENCY" } }))).resolves.toBe(
      "INVALID_INPUT",
    );
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("refuses an empty string — 'no answer' is spelled null", async () => {
    const { saveProfile } = harness();
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { sellerKind: "" } }))).resolves.toBe("INVALID_INPUT");
  });

  it("refuses a channelCount bucket outside CHANNEL_COUNTS", async () => {
    const { saveProfile } = harness();
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { channelCount: "7" } }))).resolves.toBe(
      "INVALID_INPUT",
    );
  });

  it("refuses ONE bad code inside an otherwise valid list", async () => {
    const { saveProfile, profiles } = harness();
    await expect(
      codeOf(saveProfile({ tenantId: TENANT, patch: { currentTools: ["meta_business_suite", "myspace"] } })),
    ).resolves.toBe("INVALID_INPUT");
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("refuses an absurdly long list rather than de-duplicating it", async () => {
    const { saveProfile } = harness();
    const flood = Array.from({ length: 500 }, () => "facebook");
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { focusChannels: flood } }))).resolves.toBe(
      "INVALID_INPUT",
    );
  });

  it("refuses a value that is not an array where a list is expected", async () => {
    const { saveProfile } = harness();
    const patch = { focusChannels: "facebook" } as unknown as { focusChannels: string[] };
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch }))).resolves.toBe("INVALID_INPUT");
  });

  it("refuses completedAt through save — finishing the survey is complete()'s job", async () => {
    const { saveProfile, profiles } = harness();
    const patch = { completedAt: new Date() } as unknown as Record<string, unknown>;
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch }))).resolves.toBe("INVALID_INPUT");
    expect(profiles.upsert).not.toHaveBeenCalled();
  });

  it("lets a repo failure through instead of reporting a saved step", async () => {
    const { saveProfile, profiles } = harness();
    profiles.upsert.mockRejectedValue(new AppError("DB_ERROR", { context: { tenant_id: TENANT } }));
    await expect(codeOf(saveProfile({ tenantId: TENANT, patch: { sellerKind: "agency" } }))).resolves.toBe("DB_ERROR");
  });
});

// --- The three-state contract ----------------------------------------------

describe("saveOnboardingProfile — absent / null / value are three different facts", () => {
  it("forwards ONLY the key it was given, so step 3 cannot blank steps 1 and 2", async () => {
    const stored: OnboardingProfile = {
      ...EMPTY,
      sellerKind: "shop_owner",
      currentTools: ["meta_business_suite"],
    };
    const { saveProfile, profiles } = harness(stored);

    await saveProfile({ tenantId: TENANT, patch: { channelCount: "4-6" } });

    expect(profiles.upsert).toHaveBeenCalledTimes(1);
    const [, patch] = profiles.upsert.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(patch)).toEqual(["channelCount"]);
  });

  it("passes null through as a CLEAR, which is what 'Bỏ qua' after an answer means", async () => {
    const { saveProfile, profiles } = harness({ ...EMPTY, sellerKind: "agency" });

    await saveProfile({ tenantId: TENANT, patch: { sellerKind: null } });

    const [, patch] = profiles.upsert.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch).toEqual({ sellerKind: null });
  });

  it("keeps [] as [] — 'không chọn gì' must not degrade into 'chưa trả lời'", async () => {
    const { saveProfile, profiles } = harness();

    const saved = await saveProfile({ tenantId: TENANT, patch: { focusChannels: [] } });

    const [, patch] = profiles.upsert.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch).toEqual({ focusChannels: [] });
    expect(saved.focusChannels).toEqual([]);
  });
});

// --- Normalisation ----------------------------------------------------------

describe("saveOnboardingProfile — normalisation", () => {
  it("drops repeats but keeps the order the operator picked in", async () => {
    const { saveProfile, profiles } = harness();

    await saveProfile({
      tenantId: TENANT,
      patch: { focusChannels: ["tiktok", "facebook", "tiktok", "facebook"] },
    });

    const [, patch] = profiles.upsert.mock.calls[0] as [unknown, { focusChannels: string[] }];
    expect(patch.focusChannels).toEqual(["tiktok", "facebook"]);
  });

  it("accepts every code in every list", async () => {
    const { saveProfile, profiles } = harness();

    await saveProfile({
      tenantId: TENANT,
      patch: {
        sellerKind: SELLER_KINDS[0],
        currentTools: [...TOOL_KINDS],
        channelCount: CHANNEL_COUNTS[CHANNEL_COUNTS.length - 1],
        focusChannels: [...FOCUS_CHANNELS],
      },
    });

    expect(profiles.upsert).toHaveBeenCalledTimes(1);
  });
});

// --- Reading ----------------------------------------------------------------

describe("getOnboardingProfile", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    const { getProfile } = harness();
    await expect(codeOf(getProfile({ tenantId: testTenantId(" ") }))).resolves.toBe("INVALID_INPUT");
  });

  it("answers an all-null profile when the tenant never started — not an error", async () => {
    const { getProfile } = harness(null);
    await expect(getProfile({ tenantId: TENANT })).resolves.toEqual(EMPTY);
  });

  it("returns the stored answers unchanged", async () => {
    const stored: OnboardingProfile = { ...EMPTY, sellerKind: "agency", currentTools: [] };
    const { getProfile } = harness(stored);
    await expect(getProfile({ tenantId: TENANT })).resolves.toEqual(stored);
  });

  it("lets a repo failure through instead of answering 'chưa trả lời'", async () => {
    const { getProfile, profiles } = harness();
    profiles.get.mockRejectedValue(new AppError("DB_ERROR", { context: { tenant_id: TENANT } }));
    await expect(codeOf(getProfile({ tenantId: TENANT }))).resolves.toBe("DB_ERROR");
  });
});

// --- Finishing --------------------------------------------------------------

describe("completeOnboarding", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    const { complete } = harness();
    await expect(codeOf(complete({ tenantId: testTenantId("nope") }))).resolves.toBe("INVALID_INPUT");
  });

  it("stamps completedAt from the clock on the first call", async () => {
    const { complete, profiles } = harness(null);

    const done = await complete({ tenantId: TENANT });

    const [, patch] = profiles.upsert.mock.calls[0] as [unknown, { completedAt: Date }];
    expect(patch.completedAt.toISOString()).toBe("2026-08-26T10:00:00.000Z");
    expect(done.completedAt?.toISOString()).toBe("2026-08-26T10:00:00.000Z");
  });

  it("is idempotent: a second call keeps the ORIGINAL moment and writes nothing", async () => {
    const first = new Date("2026-08-01T08:30:00.000Z");
    const { complete, profiles } = harness({ ...EMPTY, sellerKind: "agency", completedAt: first });

    const done = await complete({ tenantId: TENANT });

    expect(profiles.upsert).not.toHaveBeenCalled();
    expect(done.completedAt).toEqual(first);
    expect(done.sellerKind).toBe("agency");
  });

  it("lets a repo failure through instead of pretending the survey finished", async () => {
    const { complete, profiles } = harness(null);
    profiles.upsert.mockRejectedValue(new AppError("DB_ERROR", { context: { tenant_id: TENANT } }));
    await expect(codeOf(complete({ tenantId: TENANT }))).resolves.toBe("DB_ERROR");
  });
});
