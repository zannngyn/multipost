import { describe, expect, it } from "vitest";

import {
  foldCountLabel,
  foldRowLabel,
  groupJobRows,
  isFoldUniform,
  jobLogFoldKey,
  scheduledFoldKey,
  type JobRowGroup,
} from "../job-row-grouping";

/**
 * The fold of the two /posts tables (spec §3.2 "gom dòng trùng mã").
 *
 * Edge cases first (project standard 1): a non-array, an empty list, a row that
 * refuses to fold, a repeated channel — before the happy "5 kênh, 1 dòng".
 */

interface Row {
  readonly id: string;
  readonly channelId: string;
}

function rows(...specs: readonly (readonly [string, string])[]): Row[] {
  return specs.map(([id, channelId]) => ({ id, channelId }));
}

/** Fold everything that shares an id prefix before the dash. */
function prefixKey(row: Row): string {
  return row.id.split("-")[0]!;
}

describe("groupJobRows", () => {
  // --- Edge cases ------------------------------------------------------------
  it("returns nothing for an empty list", () => {
    expect(groupJobRows([], prefixKey)).toEqual([]);
  });

  it("survives a non-array (a failed query handing over undefined)", () => {
    expect(groupJobRows(undefined as unknown as Row[], prefixKey)).toEqual([]);
  });

  it("never folds a row whose key is null — one row in, one row out", () => {
    const groups = groupJobRows(rows(["a-1", "ch-1"], ["a-2", "ch-2"]), () => null);
    expect(groups.map((group) => group.count)).toEqual([1, 1]);
  });

  it("keeps a single row single, with the head as its only member", () => {
    const [group, ...rest] = groupJobRows(rows(["a-1", "ch-1"]), prefixKey);
    expect(rest).toEqual([]);
    expect(group!.count).toBe(1);
    expect(group!.members).toHaveLength(1);
    expect(group!.head).toBe(group!.members[0]);
  });

  it("counts DISTINCT channels, so a repeated channel cannot inflate the label", () => {
    const group = groupJobRows(rows(["a-1", "ch-1"], ["a-2", "ch-1"]), prefixKey)[0]!;
    expect(group.count).toBe(2);
    expect(group.channelCount).toBe(1);
  });

  // --- Happy path ------------------------------------------------------------
  it("folds the same key into one row and keeps source order inside it", () => {
    const groups = groupJobRows(
      rows(["a-1", "ch-1"], ["a-2", "ch-2"], ["a-3", "ch-3"]),
      prefixKey,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.members.map((row) => row.id)).toEqual(["a-1", "a-2", "a-3"]);
  });

  it("holds each group at the position of its FIRST row, not at the last one", () => {
    const groups = groupJobRows(
      rows(["a-1", "ch-1"], ["b-1", "ch-1"], ["a-2", "ch-2"]),
      prefixKey,
    );
    expect(groups.map((group) => group.head.id)).toEqual(["a-1", "b-1"]);
    expect(groups[0]!.count).toBe(2);
    expect(groups[1]!.count).toBe(1);
  });

  it("gives every group a key unique on the list, so React keys are stable", () => {
    const groups = groupJobRows(rows(["a-1", "ch-1"], ["b-1", "ch-2"]), prefixKey);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });
});

describe("foldRowLabel", () => {
  function group(count: number, channelCount: number): JobRowGroup<Row> {
    return {
      key: "k",
      head: { id: "a-1", channelId: "ch-1" },
      members: rows(["a-1", "ch-1"]),
      count,
      channelCount,
    };
  }

  it("says nothing extra for a row that stands alone", () => {
    expect(foldRowLabel("MGKVX6310", group(1, 1))).toBe("MGKVX6310");
  });

  it('reads "MGKVX6310 × 5 kênh" when five channels folded into one row', () => {
    expect(foldRowLabel("MGKVX6310", group(5, 5))).toBe("MGKVX6310 × 5 kênh");
  });

  it("counts BÀI, not kênh, when a channel appears twice — the number stays true", () => {
    expect(foldRowLabel("MGKVX6310", group(3, 2))).toBe("MGKVX6310 × 3 bài");
  });

  it("gives the count alone to a cell that already shows the code", () => {
    expect(foldCountLabel(group(1, 1))).toBeNull();
    expect(foldCountLabel(group(5, 5))).toBe("× 5 kênh");
    expect(foldCountLabel(group(3, 2))).toBe("× 3 bài");
  });
});

describe("isFoldUniform", () => {
  it("is true for a single row (nothing can disagree with itself)", () => {
    const group = groupJobRows(rows(["a-1", "ch-1"]), prefixKey)[0]!;
    expect(isFoldUniform(group, (row) => row.channelId)).toBe(true);
  });

  it("is false as soon as one member differs", () => {
    const group = groupJobRows(rows(["a-1", "ch-1"], ["a-2", "ch-2"]), prefixKey)[0]!;
    expect(isFoldUniform(group, (row) => row.channelId)).toBe(false);
  });
});

// --- The two real keys -------------------------------------------------------

function logJob(overrides: Partial<Parameters<typeof jobLogFoldKey>[0]> = {}) {
  return {
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    format: "image_post",
    status: "failed",
    attemptCount: 2,
    lastErrorCode: "FB_RATE_LIMIT",
    userMessage: "Facebook đang giới hạn tần suất.",
    canRetry: true,
    ...overrides,
  };
}

describe("jobLogFoldKey", () => {
  it("refuses to fold a row with no product code — the row could not be named", () => {
    expect(jobLogFoldKey(logJob({ productCode: "   " }))).toBeNull();
  });

  it("folds five channels of the same code failing for the same reason", () => {
    const key = jobLogFoldKey(logJob());
    expect(jobLogFoldKey(logJob())).toBe(key);
  });

  it("does NOT fold two jobs of the same code that failed differently", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(
      jobLogFoldKey(logJob({ lastErrorCode: "FB_TOKEN_EXPIRED" })),
    );
  });

  it("does NOT fold when the operator-facing sentence differs", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(
      jobLogFoldKey(logJob({ userMessage: "Hết hàng — không đăng." })),
    );
  });

  it("does NOT fold two different statuses", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ status: "published" })));
  });

  it("does NOT fold jobs that have been tried a different number of times", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ attemptCount: 5 })));
  });

  it("does NOT fold across lots — two runs of one code are two stories", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ batchId: "batch-2" })));
  });

  it("does NOT fold rows whose action differs", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ canRetry: false })));
  });

  it("keeps an ảnh and a video of one code on the same channel apart", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ format: "video_post" })));
  });

  it("keeps two colours of one code apart", () => {
    expect(jobLogFoldKey(logJob())).not.toBe(jobLogFoldKey(logJob({ color: "Đen" })));
  });

  it("cannot be fooled by a code that ends where the next field begins", () => {
    expect(jobLogFoldKey(logJob({ productCode: "AB", color: "CD" }))).not.toBe(
      jobLogFoldKey(logJob({ productCode: "ABCD", color: "" })),
    );
  });
});

function scheduledJob(overrides: Partial<Parameters<typeof scheduledFoldKey>[0]> = {}) {
  return {
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    format: "image_post",
    status: "queued",
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Chờ tới giờ đăng.",
    canReschedule: true,
    canCancel: true,
    ...overrides,
  };
}

describe("scheduledFoldKey", () => {
  it("refuses to fold a row with no product code", () => {
    expect(scheduledFoldKey(scheduledJob({ productCode: "" }))).toBeNull();
  });

  it("folds one post fanned out to several channels", () => {
    expect(scheduledFoldKey(scheduledJob())).toBe(scheduledFoldKey(scheduledJob()));
  });

  it("does NOT fold a row Facebook already holds with one still in our queue", () => {
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ status: "scheduled_on_facebook" })),
    );
  });

  it("does NOT fold an overdue row into an on-time one", () => {
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ overdue: true })),
    );
  });

  it("does NOT fold rows whose caption or photo count differ — the cell shows both", () => {
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ captionPreview: "Khác…" })),
    );
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ mediaCount: 1 })),
    );
  });

  it("does NOT fold rows that offer different actions", () => {
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ canReschedule: false })),
    );
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ canCancel: false })),
    );
  });

  it("keeps an ảnh and a video of one code apart, like the log does", () => {
    // The one field the two keys disagreed about. A photo post and a video of
    // the same code are two publications with two sets of rules; one "Đổi giờ"
    // across both would move an hour the operator never looked at.
    expect(scheduledFoldKey(scheduledJob())).not.toBe(
      scheduledFoldKey(scheduledJob({ format: "video_post" })),
    );
  });

  it("cannot be fooled by a field that ends where the next one begins", () => {
    // The NUL separator, same check the log key carries.
    expect(scheduledFoldKey(scheduledJob({ productCode: "AB", color: "CD" }))).not.toBe(
      scheduledFoldKey(scheduledJob({ productCode: "ABCD", color: "" })),
    );
  });
});

/**
 * The claims OTHER files make about these keys — asserted here, where the key
 * is, so they cannot rot silently in a comment somewhere else.
 */
describe("what the tables are allowed to assume about a fold", () => {
  it("lets the folded actions cell ask `.some()` and get the head's answer", () => {
    // `ScheduledJobTable`'s FoldedActionsNote asks
    // `group.members.some((m) => m.canReschedule)`. That only equals "what the
    // head says" because BOTH permissions are part of the key: rows that differ
    // never end up in one group, so "some" and "every" cannot disagree.
    for (const field of ["canReschedule", "canCancel"] as const) {
      const yes = scheduledJob({ [field]: true });
      const no = scheduledJob({ [field]: false });
      expect(scheduledFoldKey(yes)).not.toBe(scheduledFoldKey(no));
    }
  });

  it("throws on a hole instead of dropping a job from the table", () => {
    // The contract M-4 chose ON PURPOSE: elements come through
    // `PostJobLogEntrySchema` / `ScheduledJobEntrySchema`, so a hole is a
    // validation bug. `continue`-ing past it would take a real job out of the
    // log with nobody told (business rule 5) — a loud crash beats a silent
    // deletion. The `undefined` LIST is the case that IS survivable, and stays
    // survivable (see the guard test above).
    const holed = [scheduledJob(), undefined, scheduledJob()] as unknown as {
      channelId: string;
    }[];

    expect(() => groupJobRows(holed, (job) => scheduledFoldKey(job as never))).toThrow();
    expect(groupJobRows(undefined as never, () => null)).toEqual([]);
  });
});
