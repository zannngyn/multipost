import { describe, expect, it } from "vitest";

import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import type { BatchChannelStatus } from "@/ui/schemas/post-batch.schema";

import {
  countChannelStatuses,
  filterBatchChannels,
  matchesChannelStatus,
  showsStatusPill,
} from "../batch-channel-filter";

function channel(overrides: Partial<BatchChannelStatus> = {}): BatchChannelStatus {
  return {
    channelId: "fb-1",
    postJobId: "job-1",
    status: "published",
    productOrigin: "sheet",
    attemptCount: 1,
    publishedPostId: "123",
    publishedUrl: "https://facebook.com/a",
    publishedAt: new Date(2026, 7, 13, 10, 0).toISOString(),
    lastErrorCode: null,
    userMessage: "Đã đăng.",
    progress: null,
    ...overrides,
  };
}

const LABELS = new Map<string, GroupChannelLabel>([
  ["fb-1", { channelId: "fb-1", name: "Lady Fashion", note: "none" }],
]);

describe("countChannelStatuses", () => {
  it("counts nothing without inventing a bucket", () => {
    expect(countChannelStatuses([])).toEqual({ all: 0, published: 0, active: 0, issues: 0 });
  });

  it("puts queued and publishing in one bucket, failed and blocked in another", () => {
    const counts = countChannelStatuses([
      channel({ status: "published" }),
      channel({ status: "queued" }),
      channel({ status: "publishing" }),
      channel({ status: "failed" }),
      channel({ status: "blocked" }),
    ]);

    expect(counts).toEqual({ all: 5, published: 1, active: 2, issues: 2 });
  });

  it("counts a status no pill claims in `all` only", () => {
    // `scheduled_on_facebook` belongs to no bucket — it must not be silently
    // folded into "Đang chạy", which would promise a job the worker still owns.
    const counts = countChannelStatuses([channel({ status: "scheduled_on_facebook" })]);
    expect(counts).toEqual({ all: 1, published: 0, active: 0, issues: 0 });
  });
});

describe("matchesChannelStatus", () => {
  it("lets everything through on 'all'", () => {
    expect(matchesChannelStatus(channel({ status: "failed" }), "all")).toBe(true);
  });

  it("keeps the two-status buckets together", () => {
    expect(matchesChannelStatus(channel({ status: "queued" }), "active")).toBe(true);
    expect(matchesChannelStatus(channel({ status: "publishing" }), "active")).toBe(true);
    expect(matchesChannelStatus(channel({ status: "blocked" }), "issues")).toBe(true);
    expect(matchesChannelStatus(channel({ status: "failed" }), "issues")).toBe(true);
    expect(matchesChannelStatus(channel({ status: "published" }), "issues")).toBe(false);
  });
});

describe("filterBatchChannels", () => {
  it("searches the channel id too — that is what the table shows when names fail", () => {
    const rows = filterBatchChannels([channel()], "all", "FB-1", new Map());
    expect(rows).toHaveLength(1);
  });

  it("searches the Page name and the result sentence", () => {
    expect(filterBatchChannels([channel()], "all", "lady", LABELS)).toHaveLength(1);
    expect(filterBatchChannels([channel()], "all", "đã đăng", LABELS)).toHaveLength(1);
    expect(filterBatchChannels([channel()], "all", "outlet", LABELS)).toHaveLength(0);
  });

  it("applies status AND search, never one instead of the other", () => {
    const channels = [
      channel({ postJobId: "job-1", status: "failed", userMessage: "Token hết hạn." }),
      channel({ postJobId: "job-2", status: "published", userMessage: "Token hết hạn." }),
    ];

    const rows = filterBatchChannels(channels, "issues", "token", new Map());
    expect(rows.map((row) => row.postJobId)).toEqual(["job-1"]);
  });
});

describe("showsStatusPill — the one that strands an operator", () => {
  it("hides an empty bucket nobody is standing in", () => {
    expect(showsStatusPill(0, "issues", "all")).toBe(false);
  });

  it("KEEPS an empty bucket that is the active filter", () => {
    // The screen polls: a retry that succeeds drops "Lỗi/Chặn" to zero while it
    // is selected. Hiding the pill then leaves an empty table and no way back.
    expect(showsStatusPill(0, "issues", "issues")).toBe(true);
  });

  it("shows a bucket that has rows either way", () => {
    expect(showsStatusPill(3, "active", "all")).toBe(true);
  });
});
