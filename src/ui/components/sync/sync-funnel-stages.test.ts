import { describe, expect, it } from "vitest";

import { buildStages } from "@/ui/components/sync/sync-funnel-stages";
import { percentOf } from "@/ui/components/sync/sync-format";
import type { SyncRunCounts } from "@/ui/schemas/sync.schema";

/**
 * Edge cases first (CLAUDE.md rule 1). The two that actually happen: a tenant
 * whose Drive folder is empty (every count 0), and a failed run whose counts row
 * is all zeros but whose issues were still stored.
 */

const ZERO_COUNTS: SyncRunCounts = {
  driveFilesSeen: 0,
  mediaParsed: 0,
  mediaRejected: 0,
  mediaDuplicatesDropped: 0,
  mediaNeedingReview: 0,
  sheetRowsSeen: 0,
  productsParsed: 0,
  sheetRowsRejected: 0,
  productsWithConflict: 0,
  productsWithoutMedia: 0,
  mediaWithoutProduct: 0,
  productsWritten: 0,
  mediaWritten: 0,
  productsDeleted: 0,
  mediaDeleted: 0,
  issuesTotal: 0,
  issuesTruncated: false,
};

function counts(overrides: Partial<SyncRunCounts> = {}): SyncRunCounts {
  return { ...ZERO_COUNTS, ...overrides };
}

describe("buildStages — a run that read nothing", () => {
  const stages = buildStages(ZERO_COUNTS);

  it("still describes both stages, so the screen is not blank", () => {
    expect(stages.map((stage) => stage.ordinal)).toEqual(["01", "02"]);
  });

  it("has no share to show rather than a misleading 0%", () => {
    for (const stage of stages) {
      expect(stage.total).toBe(0);
      expect(percentOf(stage.forwardValue, stage.total)).toBeNull();
    }
  });

  it("carries a sentence for the empty case instead of an empty bar", () => {
    for (const stage of stages) {
      expect(stage.emptyLabel.length).toBeGreaterThan(20);
    }
  });

  it("adds no leftover segment when there is nothing left over", () => {
    for (const stage of stages) {
      expect(stage.segments.some((segment) => segment.key === "leftover")).toBe(false);
    }
  });

  it("produces no NaN anywhere in the stage data", () => {
    const numbers = stages.flatMap((stage) => [
      stage.total,
      stage.forwardValue,
      ...stage.segments.map((segment) => segment.value),
      ...stage.facts.map((fact) => fact.value),
    ]);

    expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("buildStages — inconsistent counts cannot produce a negative segment", () => {
  it("clamps the Drive leftover when the parts exceed the total", () => {
    const stages = buildStages(
      counts({
        driveFilesSeen: 10,
        mediaParsed: 8,
        mediaDuplicatesDropped: 5,
        mediaRejected: 4,
      }),
    );

    expect(stages[0]?.segments.some((segment) => segment.key === "leftover")).toBe(false);
    expect(stages[0]?.segments.every((segment) => segment.value >= 0)).toBe(true);
  });

  it("clamps the Sheet leftover when the parts exceed the total", () => {
    const stages = buildStages(
      counts({ sheetRowsSeen: 3, productsParsed: 5, sheetRowsRejected: 2 }),
    );

    expect(stages[1]?.segments.some((segment) => segment.key === "leftover")).toBe(false);
  });
});

describe("buildStages — the leftover is named, not hidden", () => {
  it("accounts for Sheet rows that produced no new product", () => {
    // 367 read - 359 products - 6 rejected = 2 rows merged or empty.
    const stages = buildStages(
      counts({ sheetRowsSeen: 367, productsParsed: 359, sheetRowsRejected: 6 }),
    );
    const leftover = stages[1]?.segments.find((segment) => segment.key === "leftover");

    expect(leftover?.value).toBe(2);
    expect(leftover?.tone).toBe("neutral");
  });

  it("makes the Drive segments add up to what was scanned", () => {
    const stages = buildStages(
      counts({
        driveFilesSeen: 14_987,
        mediaParsed: 9_132,
        mediaDuplicatesDropped: 4_349,
        mediaRejected: 1_506,
      }),
    );
    const sum = stages[0]?.segments.reduce((total, segment) => total + segment.value, 0);

    expect(sum).toBe(14_987);
    expect(stages[0]?.segments.some((segment) => segment.key === "leftover")).toBe(false);
  });
});

describe("buildStages — the numbers an operator reads", () => {
  const stages = buildStages(
    counts({
      driveFilesSeen: 14_987,
      mediaParsed: 9_132,
      mediaDuplicatesDropped: 4_349,
      mediaRejected: 1_506,
      mediaNeedingReview: 3_674,
      mediaWithoutProduct: 188,
      sheetRowsSeen: 367,
      productsParsed: 359,
      sheetRowsRejected: 6,
      productsWithConflict: 2,
      productsWithoutMedia: 9,
    }),
  );

  it("puts the kept count forward on each stage", () => {
    expect(stages[0]?.forwardValue).toBe(9_132);
    expect(stages[1]?.forwardValue).toBe(359);
  });

  it("labels the code-level counts as codes, not as files", () => {
    const fact = stages[0]?.facts.find((entry) => entry.key === "no-sheet-row");

    expect(fact?.value).toBe(188);
    expect(fact?.label).toContain("mã");
    expect(fact?.label).not.toContain("file");
  });

  it("keeps the review count that the old counters showed", () => {
    expect(stages[0]?.facts.find((entry) => entry.key === "needs-review")?.value).toBe(3_674);
  });

  it("carries the Sheet warnings into the stage note", () => {
    expect(stages[1]?.facts.map((entry) => entry.value)).toEqual([2, 9]);
  });
});
