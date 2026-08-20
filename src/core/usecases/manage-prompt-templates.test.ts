import { describe, expect, it } from "vitest";

import { makeFakeLogger, TEST_PROMPT_TEMPLATE } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type {
  NewPromptTemplate,
  PromptTemplateQuery,
  PromptTemplateRecord,
  PromptTemplateRepo,
} from "@/core/ports/ai";
import { makeManagePromptTemplates } from "@/core/usecases/manage-prompt-templates";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * Edge cases first: a body that cannot render, a version that does not exist,
 * a payload missing its changelog. The happy path (create v2 -> activate) comes
 * after, because that is the order the rules matter in.
 */

const TENANT = testTenantId("22222222-2222-2222-2222-222222222222");
const TARGET = { tenantId: TENANT, task: "facebook_content" as const, platform: "facebook" };

const VALID_BODY =
  "Tên: {{product.name}}\nMô tả: {{product.description}}\n{{constraints}}\n{{otherCaptions}}\n{{previousFailures}}";

/** In-memory PromptTemplateRepo with the same invariants as the drizzle one. */
function makeMemoryRepo(seed: PromptTemplateRecord[] = []): PromptTemplateRepo & {
  rows: PromptTemplateRecord[];
} {
  const rows = [...seed];
  const matches = (row: PromptTemplateRecord, query: PromptTemplateQuery) =>
    row.tenantId === query.tenantId && row.task === query.task && row.platform === query.platform;

  return {
    rows,
    async listVersions(query) {
      return rows.filter((row) => matches(row, query)).sort((a, b) => b.version - a.version);
    },
    async getActive(query) {
      return rows.find((row) => matches(row, query) && row.status === "active") ?? null;
    },
    async getVersion(query) {
      return rows.find((row) => matches(row, query) && row.version === query.version) ?? null;
    },
    async maxVersion(query) {
      return rows
        .filter((row) => matches(row, query))
        .reduce((max, row) => Math.max(max, row.version), 0);
    },
    async create(input: NewPromptTemplate) {
      if (rows.some((row) => matches(row, input) && row.version === input.version)) {
        throw new AppError("INVALID_INPUT", {
          message: "version taken",
          context: { reason: "PROMPT_VERSION_TAKEN" },
        });
      }
      if (input.activate) {
        for (const row of rows) if (matches(row, input)) row.status = "draft";
      }
      const record: PromptTemplateRecord = {
        id: input.id,
        task: input.task,
        platform: input.platform,
        tenantId: input.tenantId,
        version: input.version,
        status: input.activate ? "active" : "draft",
        systemPrompt: input.systemPrompt,
        userPromptTemplate: input.userPromptTemplate,
        changelog: input.changelog,
        name: input.name,
        variables: [...input.variables],
        createdBy: input.createdBy ?? null,
        createdAt: "2026-08-13T02:00:00.000Z",
      };
      rows.push(record);
      return record;
    },
    async activate(query) {
      const target = rows.find((row) => matches(row, query) && row.version === query.version);
      if (!target) return null;
      for (const row of rows) if (matches(row, query)) row.status = "draft";
      target.status = "active";
      return target;
    },
  };
}

function makeUsecase(repo: PromptTemplateRepo) {
  let counter = 0;
  return makeManagePromptTemplates({
    templates: repo,
    builtIn: [TEST_PROMPT_TEMPLATE],
    logger: makeFakeLogger(),
    newId: () => `tpl-${(counter += 1)}`,
  });
}

describe("manage-prompt-templates — rejections", () => {
  it("rejects a body missing a required variable, naming it", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    try {
      await usecase.createVersion({
        ...TARGET,
        name: "v2",
        systemPrompt: "SYSTEM",
        body: "Chỉ có {{constraints}}",
        changelog: "thử",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("INVALID_INPUT");
      expect((error as AppError).context.missing_variables).toEqual(["product.name"]);
      expect((error as AppError).userMessage).toContain("product.name");
    }
  });

  it("rejects a body reading a non-whitelisted field (price/stock)", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    await expect(
      usecase.createVersion({
        ...TARGET,
        name: "v2",
        systemPrompt: "SYSTEM",
        body: `${VALID_BODY}\nGiá: {{product.price}}`,
        changelog: "thử",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a version without a changelog", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    await expect(
      usecase.createVersion({
        ...TARGET,
        name: "v2",
        systemPrompt: "SYSTEM",
        body: VALID_BODY,
        changelog: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an unknown task instead of storing a template nothing can route", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    await expect(
      usecase.createVersion({
        ...TARGET,
        task: "instagram_reels_content",
        name: "v2",
        systemPrompt: "SYSTEM",
        body: VALID_BODY,
        changelog: "thử",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses to activate a version that does not exist", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    await expect(usecase.activateVersion({ ...TARGET, version: 9 })).rejects.toMatchObject({
      code: "PROMPT_NOT_FOUND",
    });
  });
});

describe("manage-prompt-templates — versioning", () => {
  it("falls back to the built-in template when the tenant has no row", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    const active = await usecase.getActive(TARGET);
    expect(active.source).toBe("built_in");
    expect(active.version).toBe(TEST_PROMPT_TEMPLATE.version);
    expect(active.body).toBe(TEST_PROMPT_TEMPLATE.userPromptTemplate);
  });

  it("numbers the first tenant version above the built-in one", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    const created = await usecase.createVersion({
      ...TARGET,
      name: "Tết voice",
      systemPrompt: "SYSTEM",
      body: VALID_BODY,
      changelog: "giọng Tết",
    });
    expect(created.template.version).toBe(TEST_PROMPT_TEMPLATE.version + 1);
    expect(created.template.status).toBe("draft");
  });

  it("never overwrites: a second create takes the next version", async () => {
    const repo = makeMemoryRepo();
    const usecase = makeUsecase(repo);
    const first = await usecase.createVersion({
      ...TARGET,
      name: "a",
      systemPrompt: "SYSTEM",
      body: VALID_BODY,
      changelog: "a",
    });
    const second = await usecase.createVersion({
      ...TARGET,
      name: "b",
      systemPrompt: "SYSTEM v2",
      body: `${VALID_BODY}\nthêm dòng`,
      changelog: "b",
    });
    expect(second.template.version).toBe(first.template.version + 1);
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0].userPromptTemplate).toBe(VALID_BODY);
  });

  it("returns warnings for unused recommended variables without blocking", async () => {
    const usecase = makeUsecase(makeMemoryRepo());
    const created = await usecase.createVersion({
      ...TARGET,
      name: "ngắn",
      systemPrompt: "SYSTEM",
      body: "{{product.name}}\n{{constraints}}",
      changelog: "bản ngắn",
    });
    expect(created.warnings.join(" ")).toContain("otherCaptions");
    expect(created.template.version).toBeGreaterThan(0);
  });

  it("activation makes exactly one version active and retires the older one", async () => {
    const repo = makeMemoryRepo();
    const usecase = makeUsecase(repo);
    const v4 = await usecase.createVersion({
      ...TARGET,
      name: "v4",
      systemPrompt: "SYSTEM",
      body: VALID_BODY,
      changelog: "v4",
      activate: true,
    });
    const v5 = await usecase.createVersion({
      ...TARGET,
      name: "v5",
      systemPrompt: "SYSTEM",
      body: `${VALID_BODY}\nkhác`,
      changelog: "v5",
    });

    await usecase.activateVersion({ ...TARGET, version: v5.template.version });

    const active = await usecase.getActive(TARGET);
    expect(active.source).toBe("tenant");
    expect(active.version).toBe(v5.template.version);

    const listing = await usecase.listVersions(TARGET);
    const older = listing.versions.find((item) => item.version === v4.template.version);
    expect(older?.status).toBe("retired");
    expect(listing.versions.filter((item) => item.status === "active")).toHaveLength(1);
    // The built-in row is always listed, read-only, so the operator can compare.
    expect(listing.versions.some((item) => item.source === "built_in")).toBe(true);
    expect(listing.nextVersion).toBe(v5.template.version + 1);
  });

  it("rolls back to the built-in template only when the tenant has no active row", async () => {
    const repo = makeMemoryRepo();
    const usecase = makeUsecase(repo);
    await usecase.createVersion({
      ...TARGET,
      name: "draft only",
      systemPrompt: "SYSTEM",
      body: VALID_BODY,
      changelog: "draft",
    });
    const active = await usecase.getActive(TARGET);
    expect(active.source).toBe("built_in");
  });
});
