import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { CreateTenantRecord, TenantOnboardingRepo } from "@/core/ports/tenant-onboarding";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";
import { testTenantId } from "@/core/domain/tenant-context.testing";

import { makeCreateTenant, slugify } from "./create-tenant";

/** M2.1 — name/slug rules + the auto-slug collision retry. */

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

function harness(options: { takenSlugs?: string[] } = {}) {
  const taken = new Set(options.takenSlugs ?? []);
  const calls: CreateTenantRecord[] = [];
  const onboarding: TenantOnboardingRepo = {
    createTenant: vi.fn(async (input: CreateTenantRecord) => {
      calls.push(input);
      if (taken.has(input.slug)) {
        throw new AppError("SLUG_TAKEN", { context: { slug: input.slug } });
      }
      return { tenantId: TENANT, name: input.name, slug: input.slug, plan: "standard" };
    }),
  };
  const usecase = makeCreateTenant({
    onboarding,
    clock,
    logger: silentLogger(),
    limits: { maxCreatedTotal: 3, maxCreatedPerHour: 1 },
    randomSuffix: () => "ab12",
  });
  return { usecase, calls };
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
