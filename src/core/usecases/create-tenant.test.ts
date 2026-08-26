import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { CreateTenantRecord, TenantOnboardingRepo } from "@/core/ports/tenant-onboarding";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";
import { testTenantId } from "@/core/domain/tenant-context.testing";

import { MAX_DERIVED_SLUG_ATTEMPTS, makeCreateTenant, slugify } from "./create-tenant";

/** M2.1 — name/slug rules + the auto-slug collision retry ladder. */

interface LogEntry {
  readonly level: "warn" | "error";
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
}

const TENANT: TenantId = testTenantId("00000000-0000-0000-0000-00000000c0de");

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_b: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

const clock: Clock = { now: () => new Date("2026-08-20T05:00:00Z"), nowMs: () => 0 };

function harness(
  options: {
    takenSlugs?: string[];
    /** True = the repo refuses this slug. Beats `takenSlugs` when given. */
    isTaken?: (slug: string) => boolean;
    randomSuffix?: () => string;
  } = {},
) {
  const taken = new Set(options.takenSlugs ?? []);
  const isTaken = options.isTaken ?? ((slug: string) => taken.has(slug));
  const calls: CreateTenantRecord[] = [];
  const logs: LogEntry[] = [];
  const onboarding: TenantOnboardingRepo = {
    createTenant: vi.fn(async (input: CreateTenantRecord) => {
      calls.push(input);
      if (isTaken(input.slug)) {
        throw new AppError("SLUG_TAKEN", { context: { slug: input.slug } });
      }
      return { tenantId: TENANT, name: input.name, slug: input.slug, plan: "standard" };
    }),
  };
  const logger: Logger = {
    ...silentLogger(),
    child: () => logger,
    warn: (message, context) => void logs.push({ level: "warn", message, context }),
    error: (message, context) => void logs.push({ level: "error", message, context }),
  };
  const usecase = makeCreateTenant({
    onboarding,
    clock,
    logger,
    limits: { maxCreatedTotal: 3, maxCreatedPerHour: 1 },
    randomSuffix: options.randomSuffix ?? (() => "ab12"),
  });
  return { usecase, calls, logs };
}

/** Distinct 4-hex chunks, like `randomBytes(2).toString("hex")` in production. */
function chunkedSuffix(): () => string {
  let n = 0;
  return () => (0x1000 + (n += 1)).toString(16);
}

const INPUT = { accountId: "acc-1", sessionEmail: "founder@x.vn", name: "Công ty Đá Mỹ Nghệ" };

// --- Edge cases first ---------------------------------------------------------

describe("createTenant — refusals", () => {
  it("401s without an account behind the session", async () => {
    const { usecase } = harness();
    await expect(usecase({ ...INPUT, accountId: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses a too-short name before touching the repo", async () => {
    const { usecase, calls } = harness();
    await expect(usecase({ ...INPUT, name: "A" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed chosen slug", async () => {
    const { usecase } = harness();
    await expect(usecase({ ...INPUT, slug: "Có Dấu!" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("surfaces SLUG_TAKEN for a slug the OPERATOR chose — no silent retry", async () => {
    const { usecase, calls } = harness({ takenSlugs: ["da-my-nghe"] });
    await expect(usecase({ ...INPUT, slug: "da-my-nghe" })).rejects.toMatchObject({
      code: "SLUG_TAKEN",
    });
    expect(calls).toHaveLength(1); // exactly one attempt
  });

  it("lets TENANT_LIMIT_REACHED from the repo pass through untouched", async () => {
    const onboarding: TenantOnboardingRepo = {
      createTenant: async () => {
        throw new AppError("TENANT_LIMIT_REACHED");
      },
    };
    const usecase = makeCreateTenant({
      onboarding,
      clock,
      logger: silentLogger(),
      limits: { maxCreatedTotal: 3, maxCreatedPerHour: 1 },
      randomSuffix: () => "ab12",
    });
    await expect(usecase(INPUT)).rejects.toMatchObject({ code: "TENANT_LIMIT_REACHED" });
  });
});

// --- Slug derivation ----------------------------------------------------------

describe("createTenant — slugs", () => {
  it("derives a diacritics-free slug from a Vietnamese name", async () => {
    const { usecase, calls } = harness();
    const result = await usecase(INPUT);
    expect(calls[0].slug).toBe("cong-ty-da-my-nghe");
    // `id`, not `tenantId` — the same shape /api/me serves (contract).
    expect(result.tenant).toEqual({
      id: TENANT,
      name: INPUT.name,
      slug: "cong-ty-da-my-nghe",
      plan: "standard",
      role: "owner",
    });
    expect(result.activeTenantId).toBe(TENANT);
  });

  it("retries a DERIVED slug once with a suffix when it collides", async () => {
    const { usecase, calls } = harness({ takenSlugs: ["cong-ty-da-my-nghe"] });
    const result = await usecase(INPUT);
    expect(calls).toHaveLength(2);
    expect(calls[1].slug).toBe("cong-ty-da-my-nghe-ab12");
    expect(result.tenant.slug).toBe("cong-ty-da-my-nghe-ab12");
  });

  it("keeps retrying a DERIVED slug across several collisions in a row", async () => {
    const suffix = chunkedSuffix();
    const { usecase, calls } = harness({
      takenSlugs: ["cong-ty-da-my-nghe", "cong-ty-da-my-nghe-1001", "cong-ty-da-my-nghe-10021003"],
      randomSuffix: suffix,
    });
    const result = await usecase(INPUT);
    expect(calls.map((call) => call.slug)).toEqual([
      "cong-ty-da-my-nghe",
      "cong-ty-da-my-nghe-1001",
      "cong-ty-da-my-nghe-10021003",
      "cong-ty-da-my-nghe-100410051006",
    ]);
    expect(result.tenant.slug).toBe("cong-ty-da-my-nghe-100410051006");
  });

  it("widens the suffix even when the entropy source repeats itself", async () => {
    // Same 4 hex chars every call: the ladder must still produce a NEW slug,
    // otherwise every retry would re-send the slug that just lost.
    const { usecase, calls } = harness({
      takenSlugs: ["cong-ty-da-my-nghe", "cong-ty-da-my-nghe-ab12"],
      randomSuffix: () => "ab12",
    });
    const result = await usecase(INPUT);
    expect(calls).toHaveLength(3);
    expect(result.tenant.slug).toBe("cong-ty-da-my-nghe-ab12ab12");
  });

  it("starts suffixed when the name carries no Latin letters at all", async () => {
    const { usecase, calls } = harness({ randomSuffix: chunkedSuffix() });
    await usecase({ ...INPUT, name: "日本語のみ" });
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe("cong-ty-1001"); // never the bare "cong-ty"
  });

  it("keeps every derived slug inside the 40-char limit", async () => {
    const long = "Công ty Cổ phần Đá Mỹ Nghệ Non Nước Đà Nẵng Việt Nam";
    const { usecase, calls } = harness({ isTaken: () => true, randomSuffix: chunkedSuffix() });
    await expect(usecase({ ...INPUT, name: long })).rejects.toMatchObject({
      code: "SLUG_DERIVATION_EXHAUSTED",
    });
    for (const call of calls) {
      expect(call.slug.length).toBeLessThanOrEqual(40);
      expect(call.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
    }
    expect(new Set(calls.map((call) => call.slug)).size).toBe(MAX_DERIVED_SLUG_ATTEMPTS);
  });

  it("gives up with a code — and a log per miss — when the ladder runs out", async () => {
    const { usecase, calls, logs } = harness({
      isTaken: () => true,
      randomSuffix: chunkedSuffix(),
    });

    const error = await usecase(INPUT).catch((caught: unknown) => caught);

    expect(AppError.is(error) && error.code).toBe("SLUG_DERIVATION_EXHAUSTED");
    expect(calls).toHaveLength(MAX_DERIVED_SLUG_ATTEMPTS);
    // The refusal that ended it is kept, not swallowed.
    expect(AppError.is(error) && AppError.is(error.cause) && error.cause.code).toBe("SLUG_TAKEN");
    expect(AppError.is(error) && error.context).toMatchObject({
      slug_base: "cong-ty-da-my-nghe",
      attempts: MAX_DERIVED_SLUG_ATTEMPTS,
    });

    const misses = logs.filter((entry) => entry.level === "warn");
    expect(misses).toHaveLength(MAX_DERIVED_SLUG_ATTEMPTS);
    expect(misses[0].context).toMatchObject({
      slug: "cong-ty-da-my-nghe",
      attempt: 1,
      max_attempts: MAX_DERIVED_SLUG_ATTEMPTS,
      error_code: "SLUG_TAKEN",
    });
    expect(logs.filter((entry) => entry.level === "error")).toHaveLength(1);
  });

  it("refuses a broken entropy source instead of re-sending the same slug", async () => {
    const { usecase, calls } = harness({
      takenSlugs: ["cong-ty-da-my-nghe"],
      randomSuffix: () => "   ",
    });
    await expect(usecase(INPUT)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(calls).toHaveLength(1);
  });

  it("passes the abuse limits into the repo record", async () => {
    const { usecase, calls } = harness();
    await usecase(INPUT);
    expect(calls[0]).toMatchObject({ maxCreatedTotal: 3, maxCreatedPerHour: 1 });
  });
});

describe("slugify", () => {
  it.each([
    ["Công ty Đá Mỹ Nghệ", "cong-ty-da-my-nghe"],
    ["  MYSP -- 2026!  ", "mysp-2026"],
    ["日本語のみ", ""],
  ])("%s -> %s", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });
});
