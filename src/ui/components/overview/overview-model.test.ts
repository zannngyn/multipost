import { describe, expect, it } from "vitest";

import {
  ATTENTION_LIMIT,
  channelLabel,
  failureReason,
  formatLoadedCount,
  pickAttentionItems,
  pickRunningBatches,
  statValue,
  type FailedJobInput,
  type RunningJobInput,
  type UpcomingJobInput,
} from "@/ui/components/overview/overview-model";
import type { Channel } from "@/ui/schemas/channel.schema";

function failed(id: string, overrides: Partial<FailedJobInput> = {}): FailedJobInput {
  return {
    id,
    code: `MGK${id}`,
    channelName: "Page A",
    reason: "Token hết hạn",
    ...overrides,
  };
}

function upcoming(id: string, overrides: Partial<UpcomingJobInput> = {}): UpcomingJobInput {
  return {
    id,
    code: `MGK${id}`,
    channelName: "Page A",
    scheduledAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("pickAttentionItems", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns [] when both sources are empty", () => {
    expect(pickAttentionItems({ failedJobs: [], upcoming: [] })).toEqual([]);
  });

  it("survives sources that are not arrays at all", () => {
    // The two hooks can hand back `undefined` mid-flight, and a screen that
    // crashed on it would take the whole overview down with it.
    const notArrays = { failedJobs: undefined, upcoming: null } as unknown as Parameters<
      typeof pickAttentionItems
    >[0];
    expect(pickAttentionItems(notArrays)).toEqual([]);
  });

  it("drops rows it could neither link to nor name", () => {
    const items = pickAttentionItems({
      failedJobs: [failed(""), failed("1", { code: "   " })],
      upcoming: [upcoming("2", { code: "" }), upcoming("3")],
    });
    expect(items.map((item) => item.id)).toEqual(["3"]);
  });

  it("keeps one row per job, and the failed side wins a tie", () => {
    // The same post_job cannot really be both, but two rows pointing at one id
    // would give the operator the same job to fix twice.
    const items = pickAttentionItems({
      failedJobs: [failed("1"), failed("1")],
      upcoming: [upcoming("1")],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "failed", id: "1" });
  });

  it("sorts the upcoming side soonest first and parks unreadable hours last", () => {
    const items = pickAttentionItems({
      failedJobs: [],
      upcoming: [
        upcoming("late", { scheduledAt: "2026-08-21T18:00:00.000Z" }),
        upcoming("broken", { scheduledAt: "khong-phai-gio" }),
        upcoming("soon", { scheduledAt: "2026-08-21T09:00:00.000Z" }),
      ],
    });
    expect(items.map((item) => item.id)).toEqual(["soon", "late", "broken"]);
  });

  // --- The rule the block exists for ----------------------------------------
  it("puts failed jobs before upcoming, caps the list at 6", () => {
    const items = pickAttentionItems({
      failedJobs: [failed("f1"), failed("f2")],
      upcoming: [
        upcoming("u1", { scheduledAt: "2026-08-21T09:00:00.000Z" }),
        upcoming("u2", { scheduledAt: "2026-08-21T10:00:00.000Z" }),
        upcoming("u3", { scheduledAt: "2026-08-21T11:00:00.000Z" }),
        upcoming("u4", { scheduledAt: "2026-08-21T12:00:00.000Z" }),
        upcoming("u5", { scheduledAt: "2026-08-21T13:00:00.000Z" }),
      ],
    });

    expect(items.slice(0, 2).every((item) => item.kind === "failed")).toBe(true);
    expect(items).toHaveLength(ATTENTION_LIMIT);
    expect(items.map((item) => item.id)).toEqual(["f1", "f2", "u1", "u2", "u3", "u4"]);
  });

  it("carries the swatch colour through when the row has one", () => {
    const items = pickAttentionItems({
      failedJobs: [failed("f1", { color: "Trắng" })],
      upcoming: [upcoming("u1")],
    });
    expect(items[0]).toMatchObject({ kind: "failed", color: "Trắng" });
    expect(items[1]).not.toHaveProperty("color");
  });

  it("keeps the newest-first order of the failed side and can fill the cap alone", () => {
    const items = pickAttentionItems({
      failedJobs: ["a", "b", "c", "d", "e", "f", "g"].map((id) => failed(id)),
      upcoming: [upcoming("u1")],
    });
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(items.every((item) => item.kind === "failed")).toBe(true);
  });
});

function running(batchId: string, overrides: Partial<RunningJobInput> = {}): RunningJobInput {
  return {
    batchId,
    status: "publishing",
    code: "MGK1000",
    scheduledAt: null,
    ...overrides,
  };
}

describe("pickRunningBatches", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns [] for anything that is not a list of jobs", () => {
    expect(pickRunningBatches([])).toEqual([]);
    expect(pickRunningBatches(undefined as unknown as RunningJobInput[])).toEqual([]);
    expect(pickRunningBatches(null as unknown as RunningJobInput[])).toEqual([]);
  });

  it("drops rows with no lot to link to", () => {
    expect(pickRunningBatches([running(""), running("   "), null as unknown as RunningJobInput]))
      .toEqual([]);
  });

  it("keeps only the two statuses a worker is actually moving", () => {
    const lots = pickRunningBatches([
      running("b1", { status: "published" }),
      running("b2", { status: "failed" }),
      running("b3", { status: "blocked" }),
      running("b4", { status: "draft" }),
      running("b5", { status: "scheduled_on_facebook" }),
      running("b6", { status: "publishing" }),
    ]);
    expect(lots.map((lot) => lot.batchId)).toEqual(["b6"]);
  });

  it("does not call a post waiting for its hour 'đang chạy'", () => {
    // `queued` holds two populations: a post meant to go out now (no hour) and
    // one parked until its hour (E8.4). The tape already counts the second as
    // "Đang chờ giờ"; counting it here too would say a lot is running when
    // nothing is moving. `publishing` means the worker holds it RIGHT NOW, so
    // an hour on that row changes nothing.
    const lots = pickRunningBatches([
      running("waiting", { status: "queued", scheduledAt: "2026-08-21T18:00:00.000Z" }),
      running("now", { status: "queued", scheduledAt: null }),
      running("held", { status: "publishing", scheduledAt: "2026-08-21T18:00:00.000Z" }),
    ]);
    expect(lots.map((lot) => lot.batchId)).toEqual(["now", "held"]);
  });

  // --- The rule the section exists for --------------------------------------
  it("groups jobs into one lot per batch, in the order they arrived", () => {
    const lots = pickRunningBatches([
      running("b2"),
      running("b1"),
      running("b2", { status: "queued" }),
      running("b1"),
      running("b1"),
    ]);
    expect(lots).toEqual([
      { batchId: "b2", jobCount: 2, code: "MGK1000" },
      { batchId: "b1", jobCount: 3, code: "MGK1000" },
    ]);
  });

  it("names the lot only when every running job of it shares one code", () => {
    const lots = pickRunningBatches([
      running("mixed", { code: "MGK1000" }),
      running("mixed", { code: "MGK2000" }),
      running("blank", { code: "   " }),
    ]);
    expect(lots).toEqual([
      { batchId: "mixed", jobCount: 2, code: null },
      // A lot whose only running row has no code is still a lot: it is counted
      // and linked, it just goes unnamed rather than printing an empty string.
      { batchId: "blank", jobCount: 1, code: null },
    ]);
  });
});

describe("formatLoadedCount", () => {
  // Edge cases first: this number is read as a fact, so anything the query
  // cannot vouch for has to look like "unknown", never like a zero.
  it("shows a dash for a count that is not a real count", () => {
    expect(formatLoadedCount({ loaded: Number.NaN, hasNextPage: false })).toBe("—");
    expect(formatLoadedCount({ loaded: -1, hasNextPage: false })).toBe("—");
    expect(formatLoadedCount({ loaded: Number.POSITIVE_INFINITY, hasNextPage: true })).toBe("—");
  });

  it("marks a first page that is not the whole story with a +", () => {
    expect(formatLoadedCount({ loaded: 25, hasNextPage: true })).toBe("25+");
    expect(formatLoadedCount({ loaded: 0, hasNextPage: true })).toBe("0+");
  });

  it("prints an exact, grouped count when every row is loaded", () => {
    expect(formatLoadedCount({ loaded: 0, hasNextPage: false })).toBe("0");
    expect(formatLoadedCount({ loaded: 7, hasNextPage: false })).toBe("7");
    expect(formatLoadedCount({ loaded: 1234, hasNextPage: false })).toBe("1.234");
  });
});

describe("failureReason", () => {
  it("falls back to the error code, then to a sentence, when the server said nothing", () => {
    expect(failureReason({ userMessage: "  ", lastErrorCode: "TOKEN_EXPIRED" })).toBe(
      "Mã lỗi TOKEN_EXPIRED",
    );
    expect(failureReason({ userMessage: null, lastErrorCode: null })).toBe(
      "Không rõ lý do — mở nhật ký để xem chi tiết.",
    );
  });

  it("prefers the sentence the server wrote for the operator", () => {
    expect(failureReason({ userMessage: "Kênh chưa cấu hình token", lastErrorCode: "X" })).toBe(
      "Kênh chưa cấu hình token",
    );
  });
});

describe("channelLabel", () => {
  const channels: Channel[] = [
    {
      channelId: "fbpage-a",
      platform: "facebook",
      name: "Shop Hoa",
      externalId: "1000",
      status: "active",
      tokenExpiresAt: null,
    },
    {
      channelId: "fbpage-b",
      platform: "facebook",
      // A Page can genuinely carry a blank name (channel.schema).
      name: "   ",
      externalId: "1001",
      status: "disabled",
      tokenExpiresAt: null,
    },
  ];

  it("renders the raw id while the channel list is not known", () => {
    // Loading or failed: naming nothing beats inventing a name.
    expect(channelLabel("fbpage-a", undefined)).toBe("fbpage-a");
    expect(channelLabel("fbpage-zzz", channels)).toBe("fbpage-zzz");
    expect(channelLabel("", channels)).toBe("—");
  });

  it("uses the Page name once the list has arrived", () => {
    expect(channelLabel("fbpage-a", channels)).toBe("Shop Hoa");
    expect(channelLabel(" fbpage-a ", channels)).toBe("Shop Hoa");
    // A Page can genuinely carry a blank name — the id stays readable then.
    expect(channelLabel("fbpage-b", channels)).toBe("fbpage-b");
  });
});

/**
 * The "0 giả" guard. Every branch here was a real reading of the same screen:
 * an operator opening the app before the queries land, and an operator whose
 * queries failed — both used to be told the number was zero.
 */
describe("statValue", () => {
  it("prints the count once a page has actually arrived", () => {
    expect(statValue({ hasData: true, isError: false, loaded: 3, hasNextPage: false })).toEqual({
      kind: "count",
      text: "3",
    });
    // Zero is only ever printed when a page really came back empty.
    expect(statValue({ hasData: true, isError: false, loaded: 0, hasNextPage: false })).toEqual({
      kind: "count",
      text: "0",
    });
  });

  it("says 'at least this many' while a cursor page is still outstanding", () => {
    expect(statValue({ hasData: true, isError: false, loaded: 25, hasNextPage: true })).toEqual({
      kind: "count",
      text: "25+",
    });
  });

  it("is loading — NOT zero — before the first page arrives", () => {
    expect(statValue({ hasData: false, isError: false, loaded: 0, hasNextPage: false })).toEqual({
      kind: "loading",
    });
  });

  it("is unavailable — NOT zero — when the query failed with no page", () => {
    expect(statValue({ hasData: false, isError: true, loaded: 0, hasNextPage: false })).toEqual({
      kind: "unavailable",
    });
  });

  it("keeps the last real number when a REFRESH fails", () => {
    // Data on screen + an error is a failed refresh, not an unknown count: the
    // notice beside the tape carries the failure, the cell keeps the truth.
    expect(statValue({ hasData: true, isError: true, loaded: 7, hasNextPage: false })).toEqual({
      kind: "count",
      text: "7",
    });
  });
});
