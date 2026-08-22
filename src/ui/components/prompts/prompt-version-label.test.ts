import { describe, expect, it } from "vitest";

import {
  describePromptVersions,
  promptRowKey,
} from "@/ui/components/prompts/prompt-version-label";
import { formatPromptDate, type PromptVersion } from "@/ui/schemas/prompt.schema";

function makeVersion(overrides: Partial<PromptVersion> & Pick<PromptVersion, "version">): PromptVersion {
  return {
    id: `id-${overrides.version}-${overrides.source ?? "tenant"}`,
    name: `Bản ${overrides.version}`,
    task: "facebook_content",
    platform: "facebook",
    status: "draft",
    source: "tenant",
    variables: [],
    changelog: "",
    createdBy: null,
    createdAt: null,
    ...overrides,
  };
}

describe("describePromptVersions", () => {
  it("returns nothing for an empty list", () => {
    expect(describePromptVersions([])).toEqual([]);
  });

  it("keeps two rows that share a version number tellable apart", () => {
    // The reachable collision: the tenant minted v2 while the built-in was still
    // v1, and the built-in has since been bumped to v2.
    const rows = describePromptVersions([
      makeVersion({
        version: 2,
        source: "tenant",
        status: "active",
        createdAt: "2026-08-20T07:30:00.000Z",
      }),
      makeVersion({ version: 2, source: "built_in", status: "retired" }),
    ]);

    const [tenant, builtIn] = rows;

    expect(tenant.key).not.toBe(builtIn.key);
    expect(tenant.label.number).toBe("v2");
    expect(builtIn.label.number).toBe("v2");
    // Same number, so BOTH rows name their origin.
    expect(tenant.label.origin).toBe("Bản của đơn vị");
    expect(builtIn.label.origin).toBe("Mẫu hệ thống");
    // And the timestamps are different facts, not two dashes.
    expect(tenant.label.stamp).toBe(formatPromptDate("2026-08-20T07:30:00.000Z"));
    expect(builtIn.label.stamp).toBe("Đi kèm phần mềm");
    expect(tenant.label.stamp).not.toBe(builtIn.label.stamp);
    expect(builtIn.label.supersededNote).toBe("Đã thay bằng bản riêng của đơn vị (v2)");
    expect(tenant.label.supersededNote).toBeNull();
  });

  it("stays quiet about origin when the number is already unique", () => {
    const [older, current] = describePromptVersions([
      makeVersion({ version: 3, source: "tenant", status: "retired" }),
      makeVersion({ version: 4, source: "tenant", status: "active" }),
    ]);

    expect(older.label.origin).toBeNull();
    expect(current.label.origin).toBeNull();
    // Never "thay bởi v4": the list cannot prove direct succession.
    expect(older.label.supersededNote).toBe("Hiện dùng v4");
  });

  it("says a tenant row lost its timestamp instead of pretending it has one", () => {
    const [row] = describePromptVersions([
      makeVersion({ version: 5, source: "tenant", status: "active", createdAt: null }),
    ]);

    expect(row.label.stamp).toBe("Không rõ thời điểm");
  });

  it("adds no replacement note while the built-in is the one running", () => {
    const [row] = describePromptVersions([
      makeVersion({ version: 2, source: "built_in", status: "active" }),
    ]);

    expect(row.label.origin).toBe("Mẫu hệ thống");
    expect(row.label.supersededNote).toBeNull();
  });

  it("drops the note when a broken payload has no active row at all", () => {
    const [row] = describePromptVersions([
      makeVersion({ version: 1, source: "tenant", status: "retired" }),
    ]);

    expect(row.label.supersededNote).toBeNull();
  });
});

describe("promptRowKey", () => {
  it("separates the two sources of one version number", () => {
    expect(promptRowKey(makeVersion({ version: 2, source: "tenant" }))).toBe("tenant-v2");
    expect(promptRowKey(makeVersion({ version: 2, source: "built_in" }))).toBe("built_in-v2");
  });
});
