import { describe, expect, it } from "vitest";

import type { PostJob } from "@/core/domain/post-job";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type {
  ListScheduledJobsQuery,
  PostJobListItem,
  PostJobRepo,
} from "@/core/ports/post-job-repo";

import {
  DEFAULT_SCHEDULED_PAGE_SIZE,
  MAX_SCHEDULED_PAGE_SIZE,
  decodeScheduledCursor,
  encodeScheduledCursor,
  makeListScheduledJobs,
} from "../list-scheduled-jobs";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E8.4 "bài đã hẹn": filters, ordering by time, and the overdue signal. */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const NOW = Date.parse("2026-08-13T02:00:00.000Z");
const CLOCK: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function item(overrides: Partial<PostJobListItem> = {}): PostJobListItem {
  const base: PostJob = {
    id: "job-1",
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: null,
    captionText: "  Giannal – NẮNG   THÁNG TÁM GỌI TÊN  ",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: new Date(NOW + 3_600_000),
    queueJobId: "pp.job-1",
  };
  return {
    ...base,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

function harness(items: PostJobListItem[]) {
  const queries: ListScheduledJobsQuery[] = [];
  const postJobs = {
    async listScheduledJobs(query: ListScheduledJobsQuery) {
      queries.push(query);
      return { items, nextCursor: null };
    },
  } as unknown as PostJobRepo;
  return {
    listScheduledJobs: makeListScheduledJobs({ postJobs, clock: CLOCK, logger: silentLogger() }),
    queries,
  };
}

// --- Edge cases first -------------------------------------------------------

describe("listScheduledJobs — rejected calls", () => {
  it("rejects a malformed tenant id", async () => {
    const { listScheduledJobs, queries } = harness([]);
    await expect(listScheduledJobs({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(queries).toHaveLength(0);
  });

  it.each(["khong-phai-ngay", "2026-13-45T99:99:99Z"])("rejects the bound %p", async (value) => {
    const { listScheduledJobs } = harness([]);
    await expect(
      listScheduledJobs({ tenantId: TENANT, filter: { from: value } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "from" } });
  });

  it("rejects a window that ends before it starts", async () => {
    const { listScheduledJobs } = harness([]);
    await expect(
      listScheduledJobs({
        tenantId: TENANT,
        filter: { from: new Date(NOW + 7_200_000), to: new Date(NOW + 3_600_000) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([0, -1, 3.5])("rejects limit %p", async (limit) => {
    const { listScheduledJobs } = harness([]);
    await expect(
      listScheduledJobs({ tenantId: TENANT, filter: { limit } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "limit" } });
  });

  it("rejects a malformed cursor", async () => {
    const { listScheduledJobs } = harness([]);
    await expect(
      listScheduledJobs({ tenantId: TENANT, filter: { cursor: "rác" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "cursor" } });
  });

  it("returns an empty page when nothing is scheduled", async () => {
    const { listScheduledJobs } = harness([]);
    const result = await listScheduledJobs({ tenantId: TENANT });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("skips a row without a scheduled time instead of showing NaN", async () => {
    const { listScheduledJobs } = harness([item({ scheduledAt: null })]);
    const result = await listScheduledJobs({ tenantId: TENANT });
    expect(result.items).toEqual([]);
  });
});

// --- Query + rows -----------------------------------------------------------

describe("listScheduledJobs — query building", () => {
  it("caps and defaults the page size", async () => {
    const { listScheduledJobs, queries } = harness([]);
    await listScheduledJobs({ tenantId: TENANT });
    await listScheduledJobs({ tenantId: TENANT, filter: { limit: 10_000 } });
    expect(queries[0].limit).toBe(DEFAULT_SCHEDULED_PAGE_SIZE);
    expect(queries[1].limit).toBe(MAX_SCHEDULED_PAGE_SIZE);
  });

  it("passes the window and the channel down, accepting ISO strings", async () => {
    const { listScheduledJobs, queries } = harness([]);
    await listScheduledJobs({
      tenantId: TENANT,
      filter: {
        from: "2026-08-13T00:00:00.000Z",
        to: "2026-08-14T00:00:00.000Z",
        channelId: " fbpage-b ",
      },
    });
    expect(queries[0].from?.toISOString()).toBe("2026-08-13T00:00:00.000Z");
    expect(queries[0].to?.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(queries[0].channelId).toBe("fbpage-b");
  });

  it("round-trips its cursor", async () => {
    const cursor = { scheduledAt: new Date(NOW + 3_600_000), id: "job-9" };
    const encoded = encodeScheduledCursor(cursor);
    expect(decodeScheduledCursor(encoded)).toEqual(cursor);
    expect(encodeScheduledCursor(null)).toBeNull();
    expect(decodeScheduledCursor(null)).toBeNull();

    const { listScheduledJobs, queries } = harness([]);
    await listScheduledJobs({ tenantId: TENANT, filter: { cursor: encoded } });
    expect(queries[0].cursor).toEqual(cursor);
  });
});

describe("listScheduledJobs — rows", () => {
  it("says how long until publish and allows both E8.4 actions", async () => {
    const { listScheduledJobs } = harness([item()]);

    const result = await listScheduledJobs({ tenantId: TENANT });

    expect(result.items[0]).toMatchObject({
      postJobId: "job-1",
      channelId: "fbpage-a",
      startsInMs: 3_600_000,
      overdue: false,
      canReschedule: true,
      canCancel: true,
      mediaCount: 1,
      userMessage: "Đang chờ trong hàng đợi để đăng",
    });
    // Caption collapsed to one line for the table.
    expect(result.items[0].captionPreview).toBe("Giannal – NẮNG THÁNG TÁM GỌI TÊN");
  });

  it("SHOWS an overdue job and says so — hiding it hides a stuck schedule", async () => {
    const { listScheduledJobs } = harness([item({ scheduledAt: new Date(NOW - 600_000) })]);

    const result = await listScheduledJobs({ tenantId: TENANT });

    expect(result.items[0]).toMatchObject({
      overdue: true,
      startsInMs: -600_000,
      canReschedule: false,
      canCancel: false,
    });
    expect(result.items[0].userMessage).toContain("quá giờ hẹn");
  });

  it("keeps a post Facebook is holding on the list — cancellable, not reschedulable (E8.6)", async () => {
    const { listScheduledJobs } = harness([
      item({ status: "scheduled_on_facebook", scheduledPostId: "555_777", queueJobId: null }),
    ]);

    const result = await listScheduledJobs({ tenantId: TENANT });

    expect(result.items[0]).toMatchObject({
      status: "scheduled_on_facebook",
      overdue: false,
      // Cancelling reaches Facebook; rescheduling our row would change nothing.
      canReschedule: false,
      canCancel: true,
    });
    expect(result.items[0].userMessage).toContain("Facebook đã nhận lịch");
  });

  it("truncates a long caption preview", async () => {
    const { listScheduledJobs } = harness([item({ captionText: "x".repeat(200) })]);
    const result = await listScheduledJobs({ tenantId: TENANT });
    expect(result.items[0].captionPreview.length).toBeLessThanOrEqual(81);
    expect(result.items[0].captionPreview.endsWith("…")).toBe(true);
  });

  it("encodes the repo cursor for the caller", async () => {
    const next = { scheduledAt: new Date(NOW + 7_200_000), id: "job-5" };
    const postJobs = {
      async listScheduledJobs() {
        return { items: [item()], nextCursor: next };
      },
    } as unknown as PostJobRepo;
    const listScheduledJobs = makeListScheduledJobs({
      postJobs,
      clock: CLOCK,
      logger: silentLogger(),
    });
    const result = await listScheduledJobs({ tenantId: TENANT });
    expect(result.nextCursor).toBe(`${next.scheduledAt.toISOString()}_job-5`);
  });
});
