import { describe, expect, it } from "vitest";

import type { PostJob } from "@/core/domain/post-job";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type {
  ListPostJobsQuery,
  PostJobListItem,
  PostJobRepo,
} from "@/core/ports/post-job-repo";

import {
  DEFAULT_POST_JOB_PAGE_SIZE,
  MAX_POST_JOB_PAGE_SIZE,
  decodePostJobCursor,
  encodePostJobCursor,
  makeListPostJobs,
} from "./list-post-jobs";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E11.1 job log: filters, keyset paging and the Vietnamese explanation column. */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

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
    status: "published",
    attemptCount: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: "100_200",
    publishedUrl: "https://facebook.com/100_200",
    publishedAt: new Date("2026-08-13T02:03:00.000Z"),
    scheduledPostId: null,
    captionText: "caption",
    media: [],
    scheduledAt: null,
    queueJobId: null,
  };
  return {
    ...base,
    createdAt: new Date("2026-08-13T02:00:00.000Z"),
    updatedAt: new Date("2026-08-13T02:03:00.000Z"),
    ...overrides,
  };
}

function harness(items: PostJobListItem[]) {
  const queries: ListPostJobsQuery[] = [];
  const postJobs = {
    async listJobs(query: ListPostJobsQuery) {
      queries.push(query);
      return { items, nextCursor: null };
    },
  } as unknown as PostJobRepo;
  return { listPostJobs: makeListPostJobs({ postJobs, logger: silentLogger() }), queries };
}

// --- Edge cases first -------------------------------------------------------

describe("listPostJobs — rejected calls", () => {
  it("rejects a malformed tenant id", async () => {
    const { listPostJobs, queries } = harness([]);
    await expect(listPostJobs({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(queries).toHaveLength(0);
  });

  it("rejects an unknown status instead of silently listing everything", async () => {
    const { listPostJobs, queries } = harness([]);
    await expect(
      listPostJobs({ tenantId: TENANT, filter: { status: "gone" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "status" } });
    expect(queries).toHaveLength(0);
  });

  it.each([0, -5, 2.5, "20" as unknown as number])("rejects limit %p", async (limit) => {
    const { listPostJobs } = harness([]);
    await expect(listPostJobs({ tenantId: TENANT, filter: { limit } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { field: "limit" },
    });
  });

  it("rejects a malformed cursor instead of restarting from page 1", async () => {
    const { listPostJobs } = harness([]);
    await expect(
      listPostJobs({ tenantId: TENANT, filter: { cursor: "not-a-cursor" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "cursor" } });
  });

  it("returns an empty page without failing when nothing matches", async () => {
    const { listPostJobs } = harness([]);
    const result = await listPostJobs({ tenantId: TENANT, filter: { batchId: "unknown" } });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// --- Filters and paging -----------------------------------------------------

describe("listPostJobs — query building", () => {
  it("caps the page size and defaults it", async () => {
    const { listPostJobs, queries } = harness([]);
    await listPostJobs({ tenantId: TENANT });
    await listPostJobs({ tenantId: TENANT, filter: { limit: 1_000 } });
    expect(queries[0].limit).toBe(DEFAULT_POST_JOB_PAGE_SIZE);
    expect(queries[1].limit).toBe(MAX_POST_JOB_PAGE_SIZE);
  });

  it("passes every filter down, product code upper-cased", async () => {
    const { listPostJobs, queries } = harness([]);
    await listPostJobs({
      tenantId: TENANT,
      filter: {
        batchId: " batch-1 ",
        status: "failed",
        channelId: "fbpage-b",
        productCode: " mgkvx6310 ",
        limit: 5,
      },
    });
    expect(queries[0]).toMatchObject({
      tenantId: TENANT,
      batchId: "batch-1",
      status: "failed",
      channelId: "fbpage-b",
      productCode: "MGKVX6310",
      limit: 5,
    });
  });

  it("decodes the cursor it produced (round trip)", async () => {
    const cursor = { createdAt: new Date("2026-08-13T02:00:00.000Z"), id: "job-9" };
    const encoded = encodePostJobCursor(cursor);
    expect(encoded).toBe("2026-08-13T02:00:00.000Z_job-9");
    expect(decodePostJobCursor(encoded)).toEqual(cursor);

    const { listPostJobs, queries } = harness([]);
    await listPostJobs({ tenantId: TENANT, filter: { cursor: encoded } });
    expect(queries[0].cursor).toEqual(cursor);
  });

  it("treats an empty cursor as 'first page'", async () => {
    expect(decodePostJobCursor(null)).toBeNull();
    expect(decodePostJobCursor("   ")).toBeNull();
    expect(encodePostJobCursor(null)).toBeNull();
  });

  it("returns the repo cursor encoded for the caller", async () => {
    const next = { createdAt: new Date("2026-08-13T01:00:00.000Z"), id: "job-5" };
    const postJobs = {
      async listJobs() {
        return { items: [item()], nextCursor: next };
      },
    } as unknown as PostJobRepo;
    const listPostJobs = makeListPostJobs({ postJobs, logger: silentLogger() });
    const result = await listPostJobs({ tenantId: TENANT });
    expect(result.nextCursor).toBe("2026-08-13T01:00:00.000Z_job-5");
  });
});

// --- The rows the operator reads -------------------------------------------

describe("listPostJobs — entries", () => {
  it("carries the Vietnamese reason and the retry flag for a blocked job", async () => {
    const { listPostJobs } = harness([
      item({
        id: "job-2",
        status: "blocked",
        attemptCount: 0,
        publishedPostId: null,
        publishedUrl: null,
        publishedAt: null,
        scheduledPostId: null,
        lastErrorCode: "OUT_OF_STOCK",
        lastErrorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      }),
    ]);

    const result = await listPostJobs({ tenantId: TENANT });

    expect(result.items[0]).toMatchObject({
      postJobId: "job-2",
      status: "blocked",
      lastErrorCode: "OUT_OF_STOCK",
      userMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      canRetry: true,
    });
  });

  it.each([
    ["published", false],
    ["queued", false],
    ["publishing", false],
    ["draft", false],
    ["failed", true],
    ["blocked", true],
  ] as Array<[PostJob["status"], boolean]>)("marks canRetry=%s for %s", async (status, canRetry) => {
    const { listPostJobs } = harness([
      item({ status, lastErrorCode: "PUBLISH_FAILED", lastErrorMessage: "lỗi" }),
    ]);
    const result = await listPostJobs({ tenantId: TENANT });
    expect(result.items[0].canRetry).toBe(canRetry);
  });

  /**
   * Gate note 1. The row's own message says the system will NOT republish it and
   * that the operator must check the Page first; a "Chạy lại" button drawn next
   * to that sentence is an invitation to the double post it warns about. The
   * usecase refuses it anyway (DUPLICATE_POST_BLOCKED) — the button simply must
   * not be there to press (core-workflow-approval: only offer valid actions).
   */
  it("marks canRetry=false for a `failed` job whose handoff outcome is unknown", async () => {
    const { listPostJobs } = harness([
      item({
        status: "failed",
        lastErrorCode: "HANDOFF_FAILED",
        lastErrorMessage:
          "Không xác nhận được kết quả giao lịch cho Facebook — bài hẹn CÓ THỂ đã được tạo trên Trang.",
        scheduledAt: new Date("2026-08-13T03:00:00.000Z"),
        publishedPostId: null,
        publishedUrl: null,
        publishedAt: null,
      }),
    ]);

    const result = await listPostJobs({ tenantId: TENANT });

    expect(result.items[0].canRetry).toBe(false);
    // The row still explains itself — only the action is withheld.
    expect(result.items[0].userMessage).toContain("CÓ THỂ đã được tạo trên Trang");
  });

  it("keeps canRetry=true for every OTHER failure of a scheduled job", async () => {
    const { listPostJobs } = harness([
      item({
        status: "failed",
        lastErrorCode: "PUBLISH_FAILED",
        lastErrorMessage: "lỗi",
        scheduledAt: new Date("2026-08-13T03:00:00.000Z"),
      }),
    ]);
    expect((await listPostJobs({ tenantId: TENANT })).items[0].canRetry).toBe(true);
  });

  it("keeps the row timestamps so the log can be read chronologically", async () => {
    const { listPostJobs } = harness([item()]);
    const result = await listPostJobs({ tenantId: TENANT });
    expect(result.items[0].createdAt).toEqual(new Date("2026-08-13T02:00:00.000Z"));
    expect(result.items[0].updatedAt).toEqual(new Date("2026-08-13T02:03:00.000Z"));
  });
});

/**
 * Onboarding phase 3. The job log is the screen that answers "bài này lấy dữ
 * liệu từ đâu", so the origin is read off the row itself: joining `product`
 * would return nothing for exactly the posts worth asking about (a code that
 * was deleted or re-synced since).
 */
describe("listPostJobs — product origin", () => {
  it("defaults to sheet for a row created before the stamp existed", async () => {
    const { listPostJobs } = harness([item()]);

    const result = await listPostJobs({ tenantId: TENANT });

    expect(result.items[0].productOrigin).toBe("sheet");
  });

  it("reports each row's own origin, never the page's first one", async () => {
    const { listPostJobs } = harness([
      item({ id: "job-1", productOrigin: "manual" }),
      item({ id: "job-2", productOrigin: "sheet" }),
    ]);

    const result = await listPostJobs({ tenantId: TENANT });

    expect(result.items.map((entry) => entry.productOrigin)).toEqual(["manual", "sheet"]);
  });

  it("counts the typed-data rows of the page in the log line", async () => {
    const lines: { message: string; context?: LogContext }[] = [];
    const recording: Logger = {
      child: (_bindings: LogBindings) => recording,
      debug: (message: string, context?: LogContext) => lines.push({ message, context }),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const items = [item({ id: "job-1", productOrigin: "manual" }), item({ id: "job-2" })];
    const postJobs = {
      async listJobs() {
        return { items, nextCursor: null };
      },
    } as unknown as PostJobRepo;

    await makeListPostJobs({ postJobs, logger: recording })({ tenantId: TENANT });

    const line = lines.find((entry) => entry.message === "Post job log read");
    expect(line?.context).toMatchObject({ returned: 2, manual_origin_count: 1 });
  });
});
