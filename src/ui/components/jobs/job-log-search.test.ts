import { describe, expect, it } from "vitest";

import type { PostJobLogEntry } from "@/ui/schemas/post-batch.schema";

import { filterJobsBySearch, matchesJobSearch } from "./job-log-search";

function job(overrides: Partial<PostJobLogEntry> = {}): PostJobLogEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-77",
    productCode: "MGKVX6310",
    productOrigin: "sheet",
    color: "Tím",
    channelId: "fb-1",
    format: "image_post",
    status: "failed",
    attemptCount: 2,
    lastErrorCode: "FB_RATE_LIMIT",
    userMessage: "Facebook đang giới hạn tần suất.",
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledAt: null,
    createdAt: new Date(2026, 7, 13, 9, 0).toISOString(),
    updatedAt: new Date(2026, 7, 13, 10, 0).toISOString(),
    canRetry: true,
    ...overrides,
  };
}

describe("matchesJobSearch — edge cases first", () => {
  it("matches everything for an empty or whitespace query", () => {
    expect(matchesJobSearch(job(), "")).toBe(true);
    expect(matchesJobSearch(job(), "   ")).toBe(true);
  });

  it("does not blow up on a job with no error code", () => {
    expect(matchesJobSearch(job({ lastErrorCode: null }), "FB_RATE")).toBe(false);
  });

  it("ignores case and surrounding spaces, because operators paste", () => {
    expect(matchesJobSearch(job(), "  mgkvx6310 ")).toBe(true);
  });
});

describe("matchesJobSearch — the fields an operator actually types", () => {
  it("finds a post by product code, channel, batch, message or error code", () => {
    expect(matchesJobSearch(job(), "MGKVX")).toBe(true);
    expect(matchesJobSearch(job(), "fb-1")).toBe(true);
    expect(matchesJobSearch(job(), "batch-77")).toBe(true);
    expect(matchesJobSearch(job(), "giới hạn")).toBe(true);
    expect(matchesJobSearch(job(), "FB_RATE_LIMIT")).toBe(true);
  });

  it("says no when nothing on the row carries the query", () => {
    expect(matchesJobSearch(job(), "MGKVX9999")).toBe(false);
  });
});

describe("filterJobsBySearch", () => {
  it("hands back the SAME list when there is no query — no needless re-render", () => {
    const jobs = [job(), job({ postJobId: "job-2" })];
    expect(filterJobsBySearch(jobs, "  ")).toBe(jobs);
  });

  it("keeps the catalog's order among the rows that matched", () => {
    const jobs = [
      job({ postJobId: "job-1", productCode: "MGKVX0001" }),
      job({ postJobId: "job-2", productCode: "AOTHUN0002" }),
      job({ postJobId: "job-3", productCode: "MGKVX0003" }),
    ];

    expect(filterJobsBySearch(jobs, "mgkvx").map((row) => row.postJobId)).toEqual([
      "job-1",
      "job-3",
    ]);
  });

  it("returns nothing when the code lives on a page that was never fetched", () => {
    // The point of the rule: this is a TRUE answer about loaded rows and a FALSE
    // one about the log. JobLogScreen must therefore never print "không có bài
    // nào khớp" while `hasNextPage` — it offers "tải thêm rồi tìm lại" instead.
    expect(filterJobsBySearch([job({ productCode: "MGKVX0001" })], "MGKVX9999")).toEqual([]);
  });
});
