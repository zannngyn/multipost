import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TEMPLATES,
  makeStaticPromptStore,
} from "@/adapters/ai/prompt-store/static-prompt-store";
import { FACEBOOK_CONTENT_TEMPLATE_V1 } from "@/adapters/ai/prompt-store/templates/facebook-content";
import { extractVariables } from "@/core/ai/prompt-render";
import { AppError } from "@/core/domain/errors";

describe("static prompt store — catalog integrity", () => {
  it("rejects a template missing a required variable", () => {
    expect(() =>
      makeStaticPromptStore([
        { ...FACEBOOK_CONTENT_TEMPLATE_V1, userPromptTemplate: "Không có biến nào" },
      ]),
    ).toThrowError(AppError);
  });

  it("rejects two active templates for the same (tenant, task, platform)", () => {
    expect(() =>
      makeStaticPromptStore([
        FACEBOOK_CONTENT_TEMPLATE_V1,
        { ...FACEBOOK_CONTENT_TEMPLATE_V1, id: "other", version: 2 },
      ]),
    ).toThrowError(AppError);
  });

  it("ignores draft and retired versions", async () => {
    const store = makeStaticPromptStore([
      { ...FACEBOOK_CONTENT_TEMPLATE_V1, version: 2, status: "draft" },
      FACEBOOK_CONTENT_TEMPLATE_V1,
      { ...FACEBOOK_CONTENT_TEMPLATE_V1, version: 0, status: "retired" },
    ]);
    const template = await store.getActive({
      tenantId: "tenant-1",
      task: "facebook_content",
      platform: "facebook",
    });
    expect(template?.version).toBe(1);
  });

  it("returns null for a task without an active template", async () => {
    const store = makeStaticPromptStore();
    expect(
      await store.getActive({ tenantId: "t1", task: "difficult_content", platform: "facebook" }),
    ).toBeNull();
  });

  it("prefers a tenant-owned template over the built-in one", async () => {
    const store = makeStaticPromptStore([
      FACEBOOK_CONTENT_TEMPLATE_V1,
      { ...FACEBOOK_CONTENT_TEMPLATE_V1, id: "tenant-1-fb", tenantId: "tenant-1", version: 9 },
    ]);
    const template = await store.getActive({
      tenantId: "tenant-1",
      task: "facebook_content",
      platform: "facebook",
    });
    expect(template?.id).toBe("tenant-1-fb");
  });
});

describe("built-in Facebook template", () => {
  it("uses ONLY whitelisted product variables (CLAUDE.md business rule 2)", () => {
    const variables = extractVariables(FACEBOOK_CONTENT_TEMPLATE_V1.userPromptTemplate);
    const productVariables = variables.filter((name) => name.startsWith("product."));
    expect(productVariables.sort()).toEqual([
      "product.category",
      "product.description",
      "product.name",
      "product.season",
    ]);
  });

  it("states the brief's hard rules: trust the sheet over the image, no price", () => {
    const system = FACEBOOK_CONTENT_TEMPLATE_V1.systemPrompt;
    expect(system).toContain("TIN DỮ LIỆU");
    expect(system).toContain("giá tiền");
    expect(system).toContain("claims");
  });

  it("ships exactly one active built-in template", () => {
    expect(BUILT_IN_TEMPLATES.filter((item) => item.status === "active")).toHaveLength(1);
  });
});
