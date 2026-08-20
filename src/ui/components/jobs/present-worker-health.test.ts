import { describe, expect, it } from "vitest";

import {
  WorkerHealthSchema,
  formatWaitDuration,
  type WorkerHealth,
} from "@/ui/schemas/worker-health.schema";

import { presentWorkerHealth } from "./present-worker-health";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that must never
 * regress: the banner stays silent when the system is healthy. A false alarm
 * teaches operators to ignore the one alarm that matters.
 */

function health(overrides: Partial<WorkerHealth> = {}): WorkerHealth {
  return {
    workersAvailable: true,
    queueReachable: true,
    untouchedQueuedJobs: 0,
    oldestUntouchedWaitMs: null,
    checkedAt: "2026-08-17T09:00:00.000Z",
    ...overrides,
  };
}

describe("presentWorkerHealth — silence", () => {
  it("says nothing while there is no reading yet (loading)", () => {
    expect(presentWorkerHealth({})).toBeNull();
    expect(presentWorkerHealth({ health: null })).toBeNull();
  });

  it("says nothing when a worker is online and nothing is waiting", () => {
    expect(presentWorkerHealth({ health: health() })).toBeNull();
  });

  it("says nothing when workers are online and posts are waiting their turn", () => {
    // Publish spacing legitimately leaves the tail of a batch untouched.
    const notice = presentWorkerHealth({
      health: health({ workersAvailable: true, untouchedQueuedJobs: 40, oldestUntouchedWaitMs: 39 * 60_000 }),
    });
    expect(notice).toBeNull();
  });

  it("keeps the last good reading when a later poll fails", () => {
    expect(presentWorkerHealth({ health: health(), hasError: true })).toBeNull();
  });
});

describe("presentWorkerHealth — no worker, posts waiting", () => {
  const notice = presentWorkerHealth({
    health: health({ workersAvailable: false, untouchedQueuedJobs: 5, oldestUntouchedWaitMs: 22 * 60_000 }),
  });

  it("is the loudest of the three situations", () => {
    expect(notice?.kind).toBe("workers-down-with-backlog");
    expect(notice?.tone).toBe("critical");
  });

  it("carries the count and the longest wait so severity is readable", () => {
    expect(notice?.description).toContain("5 bài");
    expect(notice?.description).toContain("22 phút");
  });

  it("promises the posts are not lost and names the next step", () => {
    expect(notice?.description).toMatch(/không bị mất/i);
    expect(notice?.action).toMatch(/báo người phụ trách kỹ thuật/i);
  });

  it("drops the wait sentence rather than printing a broken number", () => {
    const withoutWait = presentWorkerHealth({
      health: health({ workersAvailable: false, untouchedQueuedJobs: 3, oldestUntouchedWaitMs: null }),
    });
    expect(withoutWait?.kind).toBe("workers-down-with-backlog");
    expect(withoutWait?.description).toContain("3 bài");
    expect(withoutWait?.description).not.toMatch(/NaN|Infinity|chờ lâu nhất/);
  });
});

describe("presentWorkerHealth — no worker, nothing waiting", () => {
  const notice = presentWorkerHealth({ health: health({ workersAvailable: false }) });

  it("is an early warning, not the incident wording", () => {
    expect(notice?.kind).toBe("workers-down-idle");
    expect(notice?.tone).toBe("warning");
    expect(notice?.description).toMatch(/chưa bài nào bị lỡ/i);
  });

  it("never claims the log below is empty — it may still show queued rows", () => {
    // Scheduled posts and already-attempted posts stay `queued` in the table
    // even when `untouchedQueuedJobs` is 0.
    expect(notice?.description).not.toMatch(/không có bài nào đang chờ/i);
  });

  it("still warns that posting now would go nowhere", () => {
    expect(notice?.description).toMatch(/nằm im|không tự lên/i);
  });
});

describe("presentWorkerHealth — queue unreachable", () => {
  it("refuses to conclude anything about the workers", () => {
    // Even with `workersOnline: 0` in the payload: that number was not measured.
    const notice = presentWorkerHealth({
      health: health({ queueReachable: false, workersAvailable: false, untouchedQueuedJobs: 9 }),
    });
    expect(notice?.kind).toBe("queue-unreachable");
    expect(notice?.description).not.toMatch(/không có máy đăng bài nào chạy/i);
    expect(notice?.description).toMatch(/chưa thể khẳng định/i);
  });

  it("outranks a healthy-looking worker count too", () => {
    const notice = presentWorkerHealth({ health: health({ queueReachable: false }) });
    expect(notice?.kind).toBe("queue-unreachable");
  });
});

describe("presentWorkerHealth — the check itself failed", () => {
  const notice = presentWorkerHealth({ hasError: true });

  it("is the quietest notice and does not claim posts are stuck", () => {
    expect(notice?.kind).toBe("check-failed");
    expect(notice?.tone).toBe("muted");
    expect(notice?.description).toMatch(/danh sách bài bên dưới vẫn đúng/i);
  });
});

describe("presentWorkerHealth — defensive numbers", () => {
  /**
   * M3.3 field-level: the banner reads `workersAvailable` (everyone gets it),
   * never the optional `workersOnline` (platform staff only). An ABSENT count
   * must not read as zero — that would fire "không có máy nào chạy" at every
   * customer the moment the field stopped being sent to them.
   */
  it("stays silent for an operator who receives no worker count at all", () => {
    const { workersOnline: _hidden, ...withoutCount } = health({ workersOnline: 3 });
    expect(presentWorkerHealth({ health: withoutCount })).toBeNull();
  });

  it("fires on the boolean even when a count is present and non-zero", () => {
    // Contradictory payload; the flag is the contract, so the flag wins.
    const notice = presentWorkerHealth({
      health: health({ workersAvailable: false, workersOnline: 2, untouchedQueuedJobs: 2 }),
    });
    expect(notice?.kind).toBe("workers-down-with-backlog");
  });

  it("never prints a negative job count", () => {
    const notice = presentWorkerHealth({
      health: health({ workersAvailable: false, untouchedQueuedJobs: -4 }),
    });
    expect(notice?.kind).toBe("workers-down-idle");
  });
});

describe("WorkerHealthSchema", () => {
  it("accepts the agreed payload", () => {
    expect(WorkerHealthSchema.safeParse(health()).success).toBe(true);
  });

  it("rejects a payload missing queueReachable — an absent flag is not `true`", () => {
    const { queueReachable: _drop, ...rest } = health();
    expect(WorkerHealthSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-numeric worker count when one IS sent", () => {
    expect(WorkerHealthSchema.safeParse({ ...health(), workersOnline: "0" }).success).toBe(false);
  });

  it("accepts a payload with no worker count — that is the customer's view", () => {
    const { workersOnline: _hidden, ...withoutCount } = health({ workersOnline: 1 });
    expect(WorkerHealthSchema.safeParse(withoutCount).success).toBe(true);
  });

  it("rejects a payload missing workersAvailable — everyone receives that one", () => {
    const { workersAvailable: _drop, ...rest } = health();
    expect(WorkerHealthSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts a null oldest wait, rejects a negative one", () => {
    expect(WorkerHealthSchema.safeParse(health({ oldestUntouchedWaitMs: null })).success).toBe(true);
    expect(WorkerHealthSchema.safeParse(health({ oldestUntouchedWaitMs: -1 })).success).toBe(false);
  });
});

describe("formatWaitDuration", () => {
  it("drops unusable numbers instead of rendering them", () => {
    expect(formatWaitDuration(null)).toBeNull();
    expect(formatWaitDuration(undefined)).toBeNull();
    expect(formatWaitDuration(Number.NaN)).toBeNull();
    expect(formatWaitDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatWaitDuration(-1)).toBeNull();
  });

  it("formats the ranges an operator actually sees", () => {
    expect(formatWaitDuration(0)).toBe("dưới 1 phút");
    expect(formatWaitDuration(59_999)).toBe("dưới 1 phút");
    expect(formatWaitDuration(60_000)).toBe("1 phút");
    expect(formatWaitDuration(22 * 60_000)).toBe("22 phút");
    expect(formatWaitDuration(2 * 3_600_000)).toBe("2 giờ");
    expect(formatWaitDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2 giờ 5 phút");
    expect(formatWaitDuration(25 * 3_600_000)).toBe("1 ngày 1 giờ");
    expect(formatWaitDuration(48 * 3_600_000)).toBe("2 ngày");
  });
});
