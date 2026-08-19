import { describe, expect, it } from "vitest";

import {
  SYNC_STATUS_HINTS,
  SYNC_STATUS_LABELS,
  SyncRunSchema,
  syncIssueGuide,
} from "@/ui/schemas/sync.schema";

/**
 * `syncIssueGuide` is the one place where an error code the screen has never
 * seen must still come out usable. Unknown codes are the edge case that matters:
 * the server can add one at any time, and a row that silently disappears breaks
 * business rule 5 ("không im lặng bỏ qua bất kỳ lỗi nào").
 */

describe("syncIssueGuide", () => {
  it("gives a concrete instruction for every code the usecase writes today", () => {
    for (const code of [
      "FILE_NAME_INVALID",
      "FILE_DUPLICATE",
      "FILE_NEEDS_REVIEW",
      "SHEET_ROW_INVALID",
      "SHEET_ERROR",
      "PRODUCT_NOT_FOUND",
      "MEDIA_NOT_FOUND",
    ]) {
      const guide = syncIssueGuide(code);
      expect(guide.action.length).toBeGreaterThan(20);
      expect(guide.severity).toMatch(/neutral|warning|error/);
    }
  });

  /**
   * The three media codes used to be one. If they collapse back onto the same
   * severity the split buys the operator nothing.
   */
  it("ranks the three media codes apart", () => {
    expect(syncIssueGuide("FILE_NAME_INVALID").severity).toBe("error");
    expect(syncIssueGuide("FILE_DUPLICATE").severity).toBe("neutral");
    expect(syncIssueGuide("FILE_NEEDS_REVIEW").severity).toBe("warning");
  });

  it("says 'nothing to do' for a duplicate and 'rename it' for a bad name", () => {
    expect(syncIssueGuide("FILE_DUPLICATE").action).toContain("Không cần làm gì");
    expect(syncIssueGuide("FILE_NAME_INVALID").action).toContain("đổi tên");
    // The old wording covered duplicates too; that sentence must be gone.
    expect(syncIssueGuide("FILE_NAME_INVALID").action).not.toContain("trùng");
  });

  it("keeps a blocking code away from the informational tone", () => {
    expect(syncIssueGuide("SHEET_ROW_INVALID").severity).toBe("error");
    expect(syncIssueGuide("PRODUCT_NOT_FOUND").severity).toBe("error");
    expect(syncIssueGuide("MEDIA_NOT_FOUND").severity).toBe("warning");
  });

  it("still answers for an unknown code instead of throwing", () => {
    const guide = syncIssueGuide("SOMETHING_NEW_FROM_THE_SERVER");
    expect(guide.severity).toBe("warning");
    expect(guide.action.length).toBeGreaterThan(20);
  });

  it("infers the tone of an unknown code from its shape", () => {
    expect(syncIssueGuide("FILE_DUPLICATE").severity).toBe("neutral");
    expect(syncIssueGuide("SHEET_CODE_CONFLICT").severity).toBe("error");
    expect(syncIssueGuide("FILE_CODE_NOT_FOUND").severity).toBe("error");
    expect(syncIssueGuide("FILE_NEEDS_REVIEW").severity).toBe("warning");
  });

  it("does not care about the case of the code", () => {
    expect(syncIssueGuide("file_duplicate").severity).toBe("neutral");
  });

  it("answers for an empty code rather than crashing the table", () => {
    expect(syncIssueGuide("").severity).toBe("warning");
  });
});

describe("status wording", () => {
  it("says something different for every run status", () => {
    const labels = Object.values(SYNC_STATUS_LABELS);
    const hints = Object.values(SYNC_STATUS_HINTS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("does not let 'partial' read like a success", () => {
    expect(SYNC_STATUS_LABELS.partial).not.toBe(SYNC_STATUS_LABELS.succeeded);
    expect(SYNC_STATUS_HINTS.partial).toContain("bỏ qua");
  });
});

describe("SyncRunSchema — history runs written before this release", () => {
  const base = {
    tenantId: "00000000-0000-0000-0000-000000000001",
    syncRunId: "run-1",
    status: "partial" as const,
    startedAt: "2026-08-13T01:00:00.000Z",
    finishedAt: "2026-08-13T01:02:30.000Z",
    counts: null,
    issues: [],
    issueGroups: null,
    errorCode: null,
    errorMessage: null,
    recentRuns: [],
  };

  it("accepts a null issueGroups instead of rejecting the whole run", () => {
    const parsed = SyncRunSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.issueGroups).toBeNull();
  });

  it("accepts a history row with no finish and no issue total", () => {
    const parsed = SyncRunSchema.safeParse({
      ...base,
      recentRuns: [
        {
          syncRunId: "run-0",
          status: "running",
          startedAt: "2026-08-13T01:00:00.000Z",
          finishedAt: null,
          issuesTotal: null,
          errorCode: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a run object that lost recentRuns entirely — that is server drift", () => {
    const { recentRuns: _dropped, ...withoutHistory } = base;
    expect(SyncRunSchema.safeParse(withoutHistory).success).toBe(false);
  });
});
