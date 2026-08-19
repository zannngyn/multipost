import { describe, expect, it } from "vitest";

import {
  fromIssueGroups,
  groupSyncIssues,
  MAX_EXAMPLES,
  totalOfGroups,
} from "@/ui/components/sync/sync-issue-groups";
import type { SyncIssue, SyncIssueGroup } from "@/ui/schemas/sync.schema";

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

/**
 * The server path. Here the count is NOT derived from the rows on screen: it was
 * computed before the server capped `issues[]`, which is the whole reason the
 * column exists. Edge cases first — a wrong count here is a number an operator
 * would act on.
 */

function serverGroup(overrides: Partial<SyncIssueGroup> = {}): SyncIssueGroup {
  return {
    errorCode: "FILE_NAME_INVALID",
    count: 4_812,
    examples: [issue()],
    ...overrides,
  };
}

describe("fromIssueGroups — edge cases", () => {
  it("returns nothing for a run with no groups", () => {
    expect(fromIssueGroups([])).toEqual([]);
  });

  it("drops a group that claims no rows instead of drawing an empty bar", () => {
    expect(fromIssueGroups([serverGroup({ count: 0 })])).toEqual([]);
    expect(fromIssueGroups([serverGroup({ count: -3 })])).toEqual([]);
    expect(fromIssueGroups([serverGroup({ count: Number.NaN })])).toEqual([]);
  });

  it("keeps a group whose examples were lost, because the count still matters", () => {
    const groups = fromIssueGroups([serverGroup({ examples: [] })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(4_812);
    expect(groups[0]?.examples).toEqual([]);
    expect(groups[0]?.reasons).toEqual([]);
  });

  it("keeps an unknown code with a fallback instruction", () => {
    const groups = fromIssueGroups([serverGroup({ errorCode: "SOMETHING_NEW", count: 2 })]);

    expect(groups[0]?.errorCode).toBe("SOMETHING_NEW");
    expect(groups[0]?.severity).toBe("warning");
    expect(groups[0]?.action.length).toBeGreaterThan(20);
  });

  it("never shows more than the agreed number of examples", () => {
    const examples = Array.from({ length: 9 }, (_, index) => issue({ ref: `file-${index}.jpg` }));
    const groups = fromIssueGroups([serverGroup({ examples })]);

    expect(groups[0]?.examples).toHaveLength(MAX_EXAMPLES);
    expect(groups[0]?.count).toBe(4_812);
  });
});

describe("fromIssueGroups — what it carries", () => {
  it("uses the server count, not the number of examples it was given", () => {
    const groups = fromIssueGroups([serverGroup({ count: 7_403, examples: [issue()] })]);
    expect(groups[0]?.count).toBe(7_403);
  });

  it("sorts by impact and breaks ties on the code", () => {
    const groups = fromIssueGroups([
      serverGroup({ errorCode: "MEDIA_NOT_FOUND", count: 5 }),
      serverGroup({ errorCode: "FILE_DUPLICATE", count: 40 }),
      serverGroup({ errorCode: "SHEET_ROW_INVALID", count: 5 }),
    ]);

    expect(groups.map((group) => group.errorCode)).toEqual([
      "FILE_DUPLICATE",
      "MEDIA_NOT_FOUND",
      "SHEET_ROW_INVALID",
    ]);
  });

  it("separates the three media codes by severity", () => {
    const groups = fromIssueGroups([
      serverGroup({ errorCode: "FILE_NAME_INVALID", count: 3 }),
      serverGroup({ errorCode: "FILE_DUPLICATE", count: 2 }),
      serverGroup({ errorCode: "FILE_NEEDS_REVIEW", count: 1 }),
    ]);
    const severity = new Map(groups.map((group) => [group.errorCode, group.severity]));

    expect(severity.get("FILE_NAME_INVALID")).toBe("error");
    expect(severity.get("FILE_DUPLICATE")).toBe("neutral");
    expect(severity.get("FILE_NEEDS_REVIEW")).toBe("warning");
  });

  it("lists the distinct reasons of the examples, without repeating one", () => {
    const groups = fromIssueGroups([
      serverGroup({
        examples: [
          issue({ reason: "NO_PRODUCT_CODE" }),
          issue({ reason: "NO_PRODUCT_CODE" }),
          issue({ reason: "EMPTY_NAME" }),
        ],
      }),
    ]);

    expect(groups[0]?.reasons).toEqual(["NO_PRODUCT_CODE", "EMPTY_NAME"]);
  });
});

describe("totalOfGroups", () => {
  it("is 0 for no groups, so a caller can compare it with issuesTotal", () => {
    expect(totalOfGroups([])).toBe(0);
  });

  it("adds the exact counts, which may disagree with issuesTotal", () => {
    const groups = fromIssueGroups([
      serverGroup({ errorCode: "FILE_NAME_INVALID", count: 4_000 }),
      serverGroup({ errorCode: "FILE_DUPLICATE", count: 403 }),
    ]);

    expect(totalOfGroups(groups)).toBe(4_403);
  });
});
