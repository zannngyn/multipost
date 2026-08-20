import { describe, expect, it } from "vitest";

import { makeDbPromptStore } from "@/adapters/ai/prompt-store/db-prompt-store";
import { makeStaticPromptStore } from "@/adapters/ai/prompt-store/static-prompt-store";
import { makeFakeLogger, TEST_PROMPT_TEMPLATE } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { PromptTemplateRecord, PromptTemplateRepo } from "@/core/ports/ai";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("55555555-5555-5555-5555-555555555555");
const QUERY = { tenantId: TENANT, task: "facebook_content" as const, platform: "facebook" };

function repoReturning(
  active: PromptTemplateRecord | null,
  error?: unknown,
): PromptTemplateRepo {
  const notUsed = () => {
    throw new Error("not used in this test");
  };
  return {
    async getActive() {
      if (error) throw error;
      return active;
    },
    listVersions: notUsed,
    getVersion: notUsed,
    maxVersion: notUsed,
    create: notUsed,
    activate: notUsed,
  };
}

const TENANT_ROW: PromptTemplateRecord = {
  id: "tpl-1",
  task: "facebook_content",
  platform: "facebook",
  tenantId: TENANT,
  version: 7,
  status: "active",
  systemPrompt: "SYSTEM riêng của shop",
  userPromptTemplate: "{{product.name}}\n{{constraints}}",
  changelog: "giọng riêng",
  name: "Giọng shop",
  variables: ["product.name", "constraints"],
  createdBy: "op@example.com",
  createdAt: "2026-08-13T02:00:00.000Z",
};

describe("db prompt store", () => {
  it("rejects a blank tenantId before touching the database", async () => {
    const store = makeDbPromptStore({
      repo: repoReturning(null),
      builtIn: makeStaticPromptStore([TEST_PROMPT_TEMPLATE]),
      logger: makeFakeLogger(),
    });
    await expect(store.getActive({ ...QUERY, tenantId: testTenantId(" ") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rethrows a database failure instead of quietly using the built-in text", async () => {
    const logger = makeFakeLogger();
    const store = makeDbPromptStore({
      repo: repoReturning(null, new AppError("DB_ERROR", { message: "connection refused" })),
      builtIn: makeStaticPromptStore([TEST_PROMPT_TEMPLATE]),
      logger,
    });

    await expect(store.getActive(QUERY)).rejects.toMatchObject({ code: "DB_ERROR" });
    expect(logger.entries.some((entry) => entry.level === "error")).toBe(true);
  });

  it("falls back to the built-in template when the tenant has no active row", async () => {
    const store = makeDbPromptStore({
      repo: repoReturning(null),
      builtIn: makeStaticPromptStore([TEST_PROMPT_TEMPLATE]),
      logger: makeFakeLogger(),
    });

    const template = await store.getActive(QUERY);
    expect(template?.id).toBe(TEST_PROMPT_TEMPLATE.id);
    expect(template?.tenantId).toBeNull();
  });

  it("prefers the tenant's active version over the built-in one", async () => {
    const store = makeDbPromptStore({
      repo: repoReturning(TENANT_ROW),
      builtIn: makeStaticPromptStore([TEST_PROMPT_TEMPLATE]),
      logger: makeFakeLogger(),
    });

    const template = await store.getActive(QUERY);
    expect(template?.id).toBe("tpl-1");
    expect(template?.version).toBe(7);
    expect(template?.systemPrompt).toContain("riêng của shop");
  });

  it("returns null when neither the tenant nor the built-in catalog has one", async () => {
    const store = makeDbPromptStore({
      repo: repoReturning(null),
      builtIn: makeStaticPromptStore([]),
      logger: makeFakeLogger(),
    });
    expect(await store.getActive(QUERY)).toBeNull();
  });
});
