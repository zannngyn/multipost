import { describe, expect, it } from "vitest";

import {
  ATTENTION_LIMIT,
  channelLabel,
  failureReason,
  formatLoadedCount,
  pickAttentionItems,
  type FailedJobInput,
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
