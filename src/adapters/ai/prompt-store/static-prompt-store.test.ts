import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TEMPLATES,
  makeStaticPromptStore,
} from "@/adapters/ai/prompt-store/static-prompt-store";
// The mechanics tests need an ACTIVE template; V2 is the shipped one. V1 is
// imported too so the version pair itself can be asserted.
import {
  FACEBOOK_CONTENT_TEMPLATE_V1,
  FACEBOOK_CONTENT_TEMPLATE_V2,
} from "@/adapters/ai/prompt-store/templates/facebook-content";
import { extractVariables } from "@/core/ai/prompt-render";
import { SHEET_COLUMNS } from "@/core/domain/product";
import { AppError } from "@/core/domain/errors";

describe("static prompt store — catalog integrity", () => {
  it("rejects a template missing a required variable", () => {
    expect(() =>
      makeStaticPromptStore([
        { ...FACEBOOK_CONTENT_TEMPLATE_V2, userPromptTemplate: "Không có biến nào" },
      ]),
    ).toThrowError(AppError);
  });

  it("rejects two active templates for the same (tenant, task, platform)", () => {
    expect(() =>
      makeStaticPromptStore([
        FACEBOOK_CONTENT_TEMPLATE_V2,
        { ...FACEBOOK_CONTENT_TEMPLATE_V2, id: "other", version: 3 },
      ]),
    ).toThrowError(AppError);
  });

  it("ignores draft and retired versions", async () => {
    const store = makeStaticPromptStore([
      { ...FACEBOOK_CONTENT_TEMPLATE_V2, version: 3, status: "draft" },
      FACEBOOK_CONTENT_TEMPLATE_V2,
      { ...FACEBOOK_CONTENT_TEMPLATE_V2, version: 0, status: "retired" },
    ]);
    const template = await store.getActive({
      tenantId: "tenant-1",
      task: "facebook_content",
      platform: "facebook",
    });
    expect(template?.version).toBe(2);
  });

  it("returns null for a task without an active template", async () => {
    const store = makeStaticPromptStore();
    expect(
      await store.getActive({ tenantId: "t1", task: "difficult_content", platform: "facebook" }),
    ).toBeNull();
  });

  it("prefers a tenant-owned template over the built-in one", async () => {
    const store = makeStaticPromptStore([
      FACEBOOK_CONTENT_TEMPLATE_V2,
      { ...FACEBOOK_CONTENT_TEMPLATE_V2, id: "tenant-1-fb", tenantId: "tenant-1", version: 9 },
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
    const variables = extractVariables(FACEBOOK_CONTENT_TEMPLATE_V2.userPromptTemplate);
    const productVariables = variables.filter((name) => name.startsWith("product."));
    expect(productVariables.sort()).toEqual([
      "product.category",
      "product.description",
      "product.name",
      "product.season",
    ]);
  });

  it("states the brief's hard rules: trust the sheet over the image, no price", () => {
    const system = FACEBOOK_CONTENT_TEMPLATE_V2.systemPrompt;
    expect(system).toContain("TIN DỮ LIỆU");
    expect(system).toContain("giá tiền");
    expect(system).toContain("claims");
  });

  it("ships exactly one active built-in template", () => {
    expect(BUILT_IN_TEMPLATES.filter((item) => item.status === "active")).toHaveLength(1);
  });

  /**
   * The prompt prints "- Chủng loại: ..." and stage 3 strips exactly those
   * labels (core/ai/validation/claim.ts, built from SHEET_COLUMNS). The two
   * lists live in different layers, so nothing but this test stops a future
   * version from renaming a label here and silently switching the stripping off
   * — which is the bug that blocked 3 of 4 real generations on 15/08/2026.
   */
  it("prints the labels stage 3 knows how to strip", () => {
    const active = BUILT_IN_TEMPLATES.find((item) => item.status === "active");
    const labels = [
      SHEET_COLUMNS.name,
      SHEET_COLUMNS.category,
      SHEET_COLUMNS.season,
      SHEET_COLUMNS.description,
    ];

    for (const label of labels) {
      expect(active?.userPromptTemplate).toContain(`- ${label}:`);
    }
  });

  /**
   * v2 exists for one reason: telling the model to quote the VALUE, not the
   * whole "- Chủng loại: ..." line. Without this the file could carry a v2 whose
   * text silently equals v1 and every other test would still pass.
   */
  it("v2 actually differs from v1, and says what it was written to say", () => {
    expect(FACEBOOK_CONTENT_TEMPLATE_V2.systemPrompt).not.toBe(
      FACEBOOK_CONTENT_TEMPLATE_V1.systemPrompt,
    );
    expect(FACEBOOK_CONTENT_TEMPLATE_V2.systemPrompt).toContain("KHÔNG kèm nhãn");
    expect(FACEBOOK_CONTENT_TEMPLATE_V1.systemPrompt).not.toContain("KHÔNG kèm nhãn");
  });

  /**
   * prompt-versioning.md §1: a version is immutable and retired versions are
   * kept, never deleted — a past generation must stay traceable to its exact
   * wording.
   */
  it("keeps v1 in the catalog, retired rather than removed", () => {
    expect(FACEBOOK_CONTENT_TEMPLATE_V1.status).toBe("retired");
    expect(BUILT_IN_TEMPLATES).toContain(FACEBOOK_CONTENT_TEMPLATE_V1);
  });

  it("changes ONLY rule 4 — the other hard rules are carried over verbatim", () => {
    const rulesOf = (text: string) =>
      text
        .split("\n")
        .filter((line) => /^\d\./u.test(line.trim()))
        .map((line) => line.trim());

    const v1Rules = rulesOf(FACEBOOK_CONTENT_TEMPLATE_V1.systemPrompt);
    const v2Rules = rulesOf(FACEBOOK_CONTENT_TEMPLATE_V2.systemPrompt);

    expect(v2Rules).toHaveLength(v1Rules.length);
    v1Rules.forEach((rule, index) => {
      if (index === 3) expect(v2Rules[index]).not.toBe(rule);
      else expect(v2Rules[index]).toBe(rule);
    });
  });
});
