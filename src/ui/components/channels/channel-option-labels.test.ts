import { describe, expect, it } from "vitest";

import {
  CHANNEL_ID_KEEP,
  channelFilterOptions,
  channelLabelIndex,
  channelSentenceName,
  dedupeChannelsAcrossGroups,
  groupToggleViews,
  pruneSelection,
} from "@/ui/components/channels/channel-option-labels";
import { shortenId } from "@/ui/schemas/catalog.schema";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: "fb-1121597217877301",
    platform: "facebook",
    name: "Lady Fashion",
    externalId: "1121597217877301",
    status: "active",
    tokenExpiresAt: null,
    ...overrides,
  };
}

function group(overrides: Partial<ChannelGroup> = {}): ChannelGroup {
  return {
    id: "grp-1",
    name: "Nhóm sáng",
    channelIds: ["fb-1121597217877301"],
    channelCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("channelLabelIndex", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns an empty index for no ids", () => {
    expect(channelLabelIndex([], [channel()]).size).toBe(0);
  });

  it("accuses nothing while the channel list is not known yet", () => {
    const index = channelLabelIndex(["fb-a"], undefined);
    expect(index.get("fb-a")).toEqual({ channelId: "fb-a", name: null, note: "none" });
  });

  it("keeps ONE entry for an id repeated across rows", () => {
    const index = channelLabelIndex(["fb-a", "fb-a"], [channel({ channelId: "fb-a" })]);
    expect(index.size).toBe(1);
    expect(index.get("fb-a")?.name).toBe("Lady Fashion");
  });

  it("marks an id that is no longer in the list as removed", () => {
    const index = channelLabelIndex(["fb-gone"], [channel({ channelId: "fb-a" })]);
    expect(index.get("fb-gone")).toEqual({ channelId: "fb-gone", name: null, note: "removed" });
  });

  it("marks a switched-off Page as disabled but keeps its name", () => {
    const index = channelLabelIndex(["fb-a"], [channel({ channelId: "fb-a", status: "disabled" })]);
    expect(index.get("fb-a")).toEqual({
      channelId: "fb-a",
      name: "Lady Fashion",
      note: "disabled",
    });
  });
});

describe("channelFilterOptions", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns nothing when there is no id to offer", () => {
    expect(channelFilterOptions([], [channel()])).toEqual([]);
  });

  it("falls back to the raw id — and no verdict — while the list is unknown", () => {
    expect(channelFilterOptions(["fb-1121597217877301"], undefined)).toEqual([
      { value: "fb-1121597217877301", label: "fb-1121597217877301" },
    ]);
  });

  it("keeps one option per id even when the same id arrives twice", () => {
    const options = channelFilterOptions(
      ["fb-a", "fb-a"],
      [channel({ channelId: "fb-a", name: "Lady Fashion" })],
    );
    expect(options).toEqual([{ value: "fb-a", label: "Lady Fashion" }]);
  });

  it("says a Page is gone instead of printing a bare id", () => {
    const options = channelFilterOptions(["fb-1121597217877301"], []);
    expect(options[0].value).toBe("fb-1121597217877301");
    expect(options[0].label).toContain("đã gỡ");
    // Middle-truncated: the tail is what tells two Page ids apart.
    expect(options[0].label).toContain("…");
  });

  it("names a switched-off Page and says it is off", () => {
    const options = channelFilterOptions(
      ["fb-a"],
      [channel({ channelId: "fb-a", name: "Lady Fashion", status: "disabled" })],
    );
    expect(options[0].label).toBe("Lady Fashion (đang tắt)");
  });

  it("uses the shared placeholder for a Page with a blank name", () => {
    const options = channelFilterOptions(["fb-a"], [channel({ channelId: "fb-a", name: "  " })]);
    expect(options[0].label).toBe("(Page chưa có tên)");
  });

  it("adds the id ONLY to options whose name would be ambiguous", () => {
    const options = channelFilterOptions(
      ["fb-a", "fb-b", "fb-c"],
      [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-b", name: "Lady Fashion" }),
        channel({ channelId: "fb-c", name: "My Shop" }),
      ],
    );
    const byValue = new Map(options.map((option) => [option.value, option.label]));
    expect(byValue.get("fb-a")).toBe("Lady Fashion · fb-a");
    expect(byValue.get("fb-b")).toBe("Lady Fashion · fb-b");
    expect(byValue.get("fb-c")).toBe("My Shop");
  });

  it("sorts by what the operator reads, not by id", () => {
    const options = channelFilterOptions(
      ["fb-z", "fb-a"],
      [
        channel({ channelId: "fb-z", name: "Áo dài Hà Nội" }),
        channel({ channelId: "fb-a", name: "Zen Store" }),
      ],
    );
    expect(options.map((option) => option.label)).toEqual(["Áo dài Hà Nội", "Zen Store"]);
  });
});

describe("channelSentenceName", () => {
  // --- Edge cases first ------------------------------------------------------
  it("falls back to the id when the channel list is unknown", () => {
    const index = channelLabelIndex(["fb-a"], undefined);
    expect(channelSentenceName("fb-a", index)).toBe("fb-a");
  });

  it("falls back to the id when the row was never resolved at all", () => {
    expect(channelSentenceName("fb-a", new Map())).toBe("fb-a");
  });

  it("says a removed Page is removed", () => {
    const index = channelLabelIndex(["fb-1121597217877301"], []);
    expect(channelSentenceName("fb-1121597217877301", index)).toContain("đã gỡ");
  });

  it("carries the id when the Page has no name to be told apart by", () => {
    const index = channelLabelIndex(
      ["fb-1121597217877301"],
      [channel({ channelId: "fb-1121597217877301", name: "   " })],
    );
    expect(channelSentenceName("fb-1121597217877301", index)).toBe(
      "(Page chưa có tên) · fb-11215…17877301",
    );
  });

  it("names a live Page, and flags a switched-off one", () => {
    const index = channelLabelIndex(
      ["fb-a", "fb-b"],
      [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-b", name: "My Shop", status: "disabled" }),
      ],
    );
    expect(channelSentenceName("fb-a", index)).toBe("Lady Fashion");
    expect(channelSentenceName("fb-b", index)).toBe("My Shop (đang tắt)");
  });
});

describe("dedupeChannelsAcrossGroups", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns nothing when the tenant has no group", () => {
    expect(dedupeChannelsAcrossGroups([], [channel()])).toEqual([]);
  });

  it("drops an id that is only whitespace — it can never be a Page", () => {
    const rows = dedupeChannelsAcrossGroups([group({ channelIds: ["  ", "fb-a"] })], []);
    expect(rows.map((row) => row.channelId)).toEqual(["fb-a"]);
  });

  it("shows a Page ONCE when two groups hold it, in first-group order", () => {
    const rows = dedupeChannelsAcrossGroups(
      [
        group({ id: "g1", name: "Nhóm sáng", channelIds: ["fb-a", "fb-b"] }),
        group({ id: "g2", name: "Nhóm chiều", channelIds: ["fb-b", "fb-c"] }),
      ],
      [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-b", name: "My Shop" }),
        channel({ channelId: "fb-c", name: "Zen Store" }),
      ],
    );
    expect(rows.map((row) => row.channelId)).toEqual(["fb-a", "fb-b", "fb-c"]);
    expect(rows[1].groupNames).toEqual(["Nhóm sáng", "Nhóm chiều"]);
  });

  it("merges an id the SAME group lists twice — one row, one group name", () => {
    // /bulk answers "bài này lên những Page nào", so one Page is one row. The
    // "Nhóm kênh" screen deliberately keeps both chips: that is where the
    // corrupt entry gets deleted.
    const rows = dedupeChannelsAcrossGroups(
      [group({ name: "Nhóm sáng", channelIds: ["fb-a", " fb-a ", "fb-a"] })],
      [channel({ channelId: "fb-a" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channelId).toBe("fb-a");
  });

  it("keys a row on the TRIMMED id, so a stray space is not a second Page", () => {
    const rows = dedupeChannelsAcrossGroups(
      [group({ channelIds: [" fb-a "] })],
      [channel({ channelId: "fb-a", name: "Lady Fashion" })],
    );
    // The trimmed form is also what gets ticked and sent to the API.
    expect(rows[0].channelId).toBe("fb-a");
    expect(rows[0].name).toBe("Lady Fashion");
  });

  it("never repeats a group name when one group lists the same id twice", () => {
    const rows = dedupeChannelsAcrossGroups(
      [group({ name: "Nhóm sáng", channelIds: ["fb-a", "fb-a"] })],
      [channel({ channelId: "fb-a" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].groupNames).toEqual(["Nhóm sáng"]);
  });

  it("refuses to offer a switched-off Page, but still lists it with a reason", () => {
    const rows = dedupeChannelsAcrossGroups(
      [group({ channelIds: ["fb-a"] })],
      [channel({ channelId: "fb-a", name: "Lady Fashion", status: "disabled" })],
    );
    expect(rows[0].name).toBe("Lady Fashion");
    expect(rows[0].note).toBe("disabled");
    expect(rows[0].selectable).toBe(false);
  });

  it("refuses to offer an id that left the channel list", () => {
    const rows = dedupeChannelsAcrossGroups([group({ channelIds: ["fb-gone"] })], []);
    expect(rows[0].note).toBe("removed");
    expect(rows[0].selectable).toBe(false);
  });

  it("keeps every row selectable while the channel list is unknown", () => {
    // A failed or still-running /api/channels must not turn "chạy hàng loạt"
    // into a screen where nothing can be ticked.
    const rows = dedupeChannelsAcrossGroups([group({ channelIds: ["fb-a"] })], undefined);
    expect(rows[0]).toMatchObject({ channelId: "fb-a", name: null, note: "none", selectable: true });
  });
});

describe("CHANNEL_ID_KEEP", () => {
  // Pinned: a Facebook Page id is `fb-` + 16 digits, and the DEFAULT keep of 6
  // cuts the tail so short that two Pages of one shop read the same. If this
  // ever goes back to 6, the middle-truncation stops doing its only job.
  it("keeps enough of a 19-character Page id to tell two apart", () => {
    expect(CHANNEL_ID_KEEP).toBe(8);
    expect(shortenId("fb-1121597217877301", CHANNEL_ID_KEEP)).toBe("fb-11215…17877301");
    expect(shortenId("fb-1121597217877301")).toBe("fb-112…877301");
  });
});

describe("groupToggleViews", () => {
  // --- Edge cases first ------------------------------------------------------
  it("returns nothing when there is no group", () => {
    expect(groupToggleViews([], [])).toEqual([]);
  });

  it("gives a group that arrived without an id a key of its own", () => {
    // The schema promises a non-blank id, but this helper already defends
    // against every other shape the payload may be wrong in — and a blank
    // `groupId` is the one that bites silently: it is the React key of the row,
    // so two id-less groups would collide and swap tick state with each other.
    const groups = [
      group({ id: "", name: "Nhóm sáng" }),
      group({ id: "   ", name: "Nhóm chiều" }),
      group({ id: undefined as unknown as string, name: "Nhóm tối" }),
    ];
    const views = groupToggleViews(groups, dedupeChannelsAcrossGroups(groups, []));

    // Still three rows — a broken id never makes a group disappear (rule 5).
    expect(views).toHaveLength(3);
    expect(views.map((view) => view.name)).toEqual(["Nhóm sáng", "Nhóm chiều", "Nhóm tối"]);
    expect(new Set(views.map((view) => view.groupId)).size).toBe(3);
    for (const view of views) expect(view.groupId.trim().length).toBeGreaterThan(0);
  });

  it("keeps the stored id, trimmed, when there is one", () => {
    expect(groupToggleViews([group({ id: " grp-7 " })], [])[0].groupId).toBe("grp-7");
  });

  it("keeps a group whose ids are all blank, with nothing to count or tick", () => {
    const groups = [group({ channelIds: ["  ", ""] })];
    const view = groupToggleViews(groups, dedupeChannelsAcrossGroups(groups, []))[0];
    // The caller renders "(chưa có Page)" from this — never "0/1".
    expect(view.rowIds).toEqual([]);
    expect(view.selectableIds).toEqual([]);
    expect(view.blockedCount).toBe(0);
  });

  it("counts the ROWS of the flat list, not the raw stored ids", () => {
    // Stored: 4 entries — one duplicate, one blank. Rows below: 2.
    const groups = [group({ channelIds: ["fb-a", "fb-a", " ", "fb-b"] })];
    const rows = dedupeChannelsAcrossGroups(groups, [
      channel({ channelId: "fb-a" }),
      channel({ channelId: "fb-b" }),
    ]);
    const view = groupToggleViews(groups, rows)[0];
    expect(view.rowIds).toEqual(["fb-a", "fb-b"]);
  });

  it("NEVER offers a switched-off or removed Page to the group toggle", () => {
    // The bug this closes: pressing "chọn cả nhóm" used to push every stored id
    // into the selection, blocked ones included, straight through to run.start.
    const groups = [group({ channelIds: ["fb-a", "fb-off", "fb-gone"] })];
    const rows = dedupeChannelsAcrossGroups(groups, [
      channel({ channelId: "fb-a" }),
      channel({ channelId: "fb-off", status: "disabled" }),
    ]);
    const view = groupToggleViews(groups, rows)[0];

    expect(view.rowIds).toEqual(["fb-a", "fb-off", "fb-gone"]);
    expect(view.selectableIds).toEqual(["fb-a"]);
    expect(view.blockedCount).toBe(2);
  });

  it("offers every row while the channel list is unknown", () => {
    const groups = [group({ channelIds: ["fb-a", "fb-b"] })];
    const view = groupToggleViews(groups, dedupeChannelsAcrossGroups(groups, undefined))[0];
    expect(view.selectableIds).toEqual(["fb-a", "fb-b"]);
    expect(view.blockedCount).toBe(0);
  });
});

describe("pruneSelection", () => {
  // --- Edge cases first ------------------------------------------------------
  it("prunes nothing when nothing is selected", () => {
    expect(pruneSelection([], [channel()])).toEqual({
      next: [],
      removedLabels: [],
      changed: false,
    });
  });

  it("prunes nothing while the channel list is still unknown", () => {
    // No answer is not an answer: emptying the box here would delete a
    // selection made a second before the query resolved.
    const verdict = pruneSelection(["fb-a"], undefined);
    expect(verdict).toEqual({ next: ["fb-a"], removedLabels: [], changed: false });
  });

  it("keeps a selection that is entirely live", () => {
    const verdict = pruneSelection(
      ["fb-a", "fb-b"],
      [channel({ channelId: "fb-a" }), channel({ channelId: "fb-b" })],
    );
    expect(verdict.changed).toBe(false);
    expect(verdict.next).toEqual(["fb-a", "fb-b"]);
  });

  it("drops ids the LATE channel list says are off or gone, and names them", () => {
    // The race: the Pages were ticked before /api/channels answered.
    const verdict = pruneSelection(
      ["fb-a", "fb-off", "fb-gone"],
      [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-off", name: "My Shop", status: "disabled" }),
      ],
    );
    expect(verdict.next).toEqual(["fb-a"]);
    expect(verdict.changed).toBe(true);
    expect(verdict.removedLabels).toEqual(["My Shop (đang tắt)", "fb-gone (đã gỡ)"]);
  });

  it("is idempotent — a pruned selection prunes to itself", () => {
    const channels = [channel({ channelId: "fb-a" })];
    const once = pruneSelection(["fb-a", "fb-gone"], channels);
    const twice = pruneSelection(once.next, channels);
    expect(twice.changed).toBe(false);
  });
});
