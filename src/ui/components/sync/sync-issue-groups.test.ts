import { describe, expect, it } from "vitest";

import { groupSyncIssues, MAX_EXAMPLES } from "@/ui/components/sync/sync-issue-groups";
import type { SyncIssue } from "@/ui/schemas/sync.schema";

/**
 * Edge cases first (CLAUDE.md rule 1). This function is what the "Cần xử lý"
 * table counts on, and its input is a list the server already truncated — so
 * "counts what it was given, nothing more" is the property under test.
 */

function issue(overrides: Partial<SyncIssue> = {}): SyncIssue {
  return {
    errorCode: "FILE_NAME_INVALID",
    reason: "MISSING_CODE",
    ref: "file.jpg",
    detail: "detail",
    ...overrides,
  };
}

describe("groupSyncIssues — edge cases", () => {
  it("returns nothing for an empty run instead of a phantom group", () => {
    expect(groupSyncIssues([])).toEqual([]);
  });

  it("keeps a group whose error code is empty rather than dropping the rows", () => {
    const groups = groupSyncIssues([issue({ errorCode: "" }), issue({ errorCode: "" })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.errorCode).toBe("");
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.action.length).toBeGreaterThan(20);
  });

  it("keeps an unknown error code, with a fallback instruction", () => {
    const groups = groupSyncIssues([issue({ errorCode: "SOMETHING_NEW" })]);

    expect(groups[0]?.errorCode).toBe("SOMETHING_NEW");
    expect(groups[0]?.severity).toBe("warning");
    expect(groups[0]?.action.length).toBeGreaterThan(20);
  });

  it("does not double-count a reason that repeats", () => {
    const groups = groupSyncIssues([
      issue({ reason: "MISSING_CODE" }),
      issue({ reason: "MISSING_CODE" }),
      issue({ reason: "DUPLICATE_FILE_NAME" }),
      issue({ reason: "MISSING_CODE" }),
    ]);

    expect(groups[0]?.reasons).toEqual(["MISSING_CODE", "DUPLICATE_FILE_NAME"]);
    expect(groups[0]?.count).toBe(4);
  });
});

describe("groupSyncIssues — grouping", () => {
  it("counts every row of the list it was handed", () => {
    const groups = groupSyncIssues([issue(), issue(), issue()]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
  });

  it("puts the biggest group first, so the most valuable fix is on top", () => {
    const groups = groupSyncIssues([
      issue({ errorCode: "SHEET_ROW_INVALID" }),
      issue({ errorCode: "FILE_NAME_INVALID" }),
      issue({ errorCode: "FILE_NAME_INVALID" }),
      issue({ errorCode: "FILE_NAME_INVALID" }),
      issue({ errorCode: "MEDIA_NOT_FOUND" }),
      issue({ errorCode: "MEDIA_NOT_FOUND" }),
    ]);

    expect(groups.map((group) => [group.errorCode, group.count])).toEqual([
      ["FILE_NAME_INVALID", 3],
      ["MEDIA_NOT_FOUND", 2],
      ["SHEET_ROW_INVALID", 1],
    ]);
  });

  it("breaks a tie on the code, so the order does not shuffle between renders", () => {
    const groups = groupSyncIssues([
      issue({ errorCode: "SHEET_ROW_INVALID" }),
      issue({ errorCode: "MEDIA_NOT_FOUND" }),
      issue({ errorCode: "FILE_NAME_INVALID" }),
    ]);

    expect(groups.map((group) => group.errorCode)).toEqual([
      "FILE_NAME_INVALID",
      "MEDIA_NOT_FOUND",
      "SHEET_ROW_INVALID",
    ]);
  });

  it("carries the severity of the code onto the group", () => {
    const groups = groupSyncIssues([
      issue({ errorCode: "SHEET_ROW_INVALID" }),
      issue({ errorCode: "MEDIA_NOT_FOUND" }),
    ]);
    const byCode = new Map(groups.map((group) => [group.errorCode, group.severity]));

    expect(byCode.get("SHEET_ROW_INVALID")).toBe("error");
    expect(byCode.get("MEDIA_NOT_FOUND")).toBe("warning");
  });
});

describe("groupSyncIssues — examples", () => {
  it(`keeps at most ${MAX_EXAMPLES} examples but still counts every row`, () => {
    const groups = groupSyncIssues(
      Array.from({ length: 40 }, (_, index) => issue({ ref: `file-${index}.jpg` })),
    );

    expect(groups[0]?.count).toBe(40);
    expect(groups[0]?.examples).toHaveLength(MAX_EXAMPLES);
  });

  it("keeps the FIRST examples, in the order the run reported them", () => {
    const groups = groupSyncIssues([
      issue({ ref: "a.jpg" }),
      issue({ ref: "b.jpg" }),
      issue({ ref: "c.jpg" }),
      issue({ ref: "d.jpg" }),
    ]);

    expect(groups[0]?.examples.map((example) => example.ref)).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("does not lose examples of a small group behind a big one", () => {
    const groups = groupSyncIssues([
      issue({ errorCode: "FILE_NAME_INVALID", ref: "a.jpg" }),
      issue({ errorCode: "FILE_NAME_INVALID", ref: "b.jpg" }),
      issue({ errorCode: "SHEET_ROW_INVALID", ref: "row 3" }),
    ]);
    const sheet = groups.find((group) => group.errorCode === "SHEET_ROW_INVALID");

    expect(sheet?.examples.map((example) => example.ref)).toEqual(["row 3"]);
  });
});
