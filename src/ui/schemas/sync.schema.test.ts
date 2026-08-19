import { describe, expect, it } from "vitest";

import { SYNC_STATUS_HINTS, SYNC_STATUS_LABELS, syncIssueGuide } from "@/ui/schemas/sync.schema";

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
