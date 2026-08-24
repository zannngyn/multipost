import { describe, expect, it } from "vitest";

import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

import {
  CHANNEL_ROWS_BEFORE_EXPAND,
  applyChannelGroup,
  applyChannelGroupSafe,
  avatarToneStyle,
  avatarToneVar,
  channelBlockReason,
  channelDropSentences,
  channelInitials,
  draftOnOpenChange,
  filterChannels,
  groupPayloadFrom,
  matchingGroupId,
  publishableChannels,
  selectAllVisible,
  toggleChannelId,
  visibleRows,
} from "./channel-picker";

/**
 * Rules of the "Chọn kênh đăng" modal. Every test here answers one question:
 * WHICH Pages is this post about to go to? A wrong answer is a post on the
 * wrong Page, so the edge cases come first (CLAUDE.md technical rule 1).
 */

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: "ch-lady",
    platform: "facebook",
    name: "Lady Fashion",
    externalId: "1010",
    status: "active",
    tokenExpiresAt: null,
    ...overrides,
  };
}

function group(overrides: Partial<ChannelGroup> = {}): ChannelGroup {
  return {
    id: "grp-main",
    name: "Bộ 5 page chính",
    channelIds: ["ch-lady", "ch-mysp"],
    channelCount: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("publishableChannels", () => {
  it("keeps Facebook only — Phase 1 has nowhere else to publish", () => {
    const list = [channel(), channel({ channelId: "tt", platform: "tiktok" })];
    expect(publishableChannels(list).map((item) => item.channelId)).toEqual(["ch-lady"]);
  });

  it("KEEPS a disabled Page instead of hiding it", () => {
    const list = [channel({ channelId: "off", status: "disabled" })];
    expect(publishableChannels(list)).toHaveLength(1);
  });
});

describe("channelBlockReason", () => {
  it("is null for a Page that can be published to", () => {
    expect(channelBlockReason(channel())).toBeNull();
  });

  it("explains a disabled Page instead of just refusing it", () => {
    expect(channelBlockReason(channel({ status: "disabled" }))).toContain("đang tắt");
  });
});

describe("filterChannels", () => {
  const list = [
    channel({ channelId: "ch-lady", name: "Lady Fashion" }),
    channel({ channelId: "ch-mysp", name: "Mys.P", externalId: "2020" }),
    channel({ channelId: "ch-camilla", name: "Camilla Hè" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterChannels(list, "   ")).toHaveLength(3);
  });

  it("matches the name regardless of case and Vietnamese marks", () => {
    expect(filterChannels(list, "lady").map((item) => item.channelId)).toEqual(["ch-lady"]);
    expect(filterChannels(list, "he").map((item) => item.channelId)).toEqual(["ch-camilla"]);
  });

  it("falls back to the ids, so a Page with no name is still findable", () => {
    expect(filterChannels(list, "2020").map((item) => item.channelId)).toEqual(["ch-mysp"]);
  });

  it("returns nothing when nothing matches — the caller shows the empty state", () => {
    expect(filterChannels(list, "zzz")).toEqual([]);
  });
});

describe("channelInitials", () => {
  it("answers FB for a Page with no usable name", () => {
    expect(channelInitials("")).toBe("FB");
    expect(channelInitials("   ")).toBe("FB");
  });

  it("takes first and last initial of a multi-word name", () => {
    expect(channelInitials("Lady Fashion")).toBe("LF");
    expect(channelInitials("Mys P Store")).toBe("MS");
  });

  it("takes two letters of a single word", () => {
    expect(channelInitials("Camilla")).toBe("CA");
  });
});

describe("avatarToneVar", () => {
  it("is stable for one name — the colour must not move when the list filters", () => {
    expect(avatarToneVar("Lady Fashion")).toBe(avatarToneVar("Lady Fashion"));
  });

  it("always names a token the stylesheet actually defines", () => {
    for (const name of ["Lady Fashion", "Mys.P", "", "Devis", "Charmia"]) {
      expect(avatarToneVar(name)).toMatch(/^var\(--chart-[1-5]\)$/);
    }
  });

  it("wears the dye as a tint, never as a solid — the ink has to stay readable", () => {
    expect(avatarToneStyle("Lady Fashion").backgroundColor).toBe(
      `color-mix(in oklch, ${avatarToneVar("Lady Fashion")} 28%, transparent)`,
    );
  });
});

describe("matchingGroupId", () => {
  const groups = [group(), group({ id: "grp-si", name: "Nhóm sĩ", channelIds: ["ch-devis"] })];

  it("lights no pill when nothing is selected", () => {
    expect(matchingGroupId(groups, new Set())).toBeNull();
  });

  it("lights the pill whose channels are EXACTLY the selection", () => {
    expect(matchingGroupId(groups, new Set(["ch-lady", "ch-mysp"]))).toBe("grp-main");
  });

  it("lights nothing when the selection merely CONTAINS the group", () => {
    expect(matchingGroupId(groups, new Set(["ch-lady", "ch-mysp", "ch-extra"]))).toBeNull();
  });

  it("lights nothing for a partial selection of a group", () => {
    expect(matchingGroupId(groups, new Set(["ch-lady"]))).toBeNull();
  });
});

describe("applyChannelGroup", () => {
  it("unions the group into the selection, keeping only active channels", () => {
    expect(applyChannelGroup(["a"], ["b", "dead"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("is idempotent", () => {
    expect(applyChannelGroup(["a", "b"], ["b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps the order: what was ticked first stays first", () => {
    expect(applyChannelGroup(["c", "a"], ["b", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("drops an already-ticked channel that can no longer be published to", () => {
    // A Page ticked before it was switched off must not travel back into the
    // selection on a group press: the post to it could only be blocked.
    expect(applyChannelGroup(["off", "a"], ["b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("adds nothing when the group is empty, and never mutates its input", () => {
    const current = ["a"];
    expect(applyChannelGroup(current, [], ["a"])).toEqual(["a"]);
    expect(current).toEqual(["a"]);
  });

  it("answers an empty selection when nothing is publishable", () => {
    expect(applyChannelGroup(["a"], ["b"], [])).toEqual([]);
  });

  it("de-duplicates a group that repeats an id", () => {
    expect(applyChannelGroup([], ["a", "a"], ["a"])).toEqual(["a"]);
  });
});

/**
 * The guard that used to be an early `return` in the click handler — which made
 * the chip do nothing AND say nothing, the one outcome a shortcut must never
 * have.
 */
describe("applyChannelGroupSafe", () => {
  it("refuses the press when the modal is listing no Pages at all", () => {
    // Query still in flight, query failed, or a tenant with no Page: all
    // three arrive here as an empty list, and all three would wipe the draft.
    expect(
      applyChannelGroupSafe({
        current: ["a"],
        groupChannelIds: ["a", "b"],
        activeChannelIds: [],
        listedChannelCount: 0,
      }),
    ).toEqual({ ok: false, reason: "no-listed-channels" });
  });

  it("refuses a count that is not a count", () => {
    const nonsense = { listedChannelCount: Number.NaN } as { listedChannelCount: number };
    expect(
      applyChannelGroupSafe({
        current: ["a"],
        groupChannelIds: ["b"],
        activeChannelIds: ["a", "b"],
        ...nonsense,
      }).ok,
    ).toBe(false);
  });

  it("keeps the draft intact when it refuses — the caller has something to show", () => {
    const current = ["a"];
    const press = applyChannelGroupSafe({
      current,
      groupChannelIds: ["b"],
      activeChannelIds: [],
      listedChannelCount: 0,
    });
    expect(press.ok).toBe(false);
    expect(current).toEqual(["a"]);
  });

  it("applies the group once there is a list to resolve it against", () => {
    expect(
      applyChannelGroupSafe({
        current: ["a"],
        groupChannelIds: ["b", "dead"],
        activeChannelIds: ["a", "b"],
        listedChannelCount: 3,
      }),
    ).toEqual({ ok: true, next: ["a", "b"] });
  });
});

describe("channelDropSentences", () => {
  const named = (id: string) => (id === "ch-lady" ? "Lady Fashion" : id === "ch-mysp" ? "MYSP Shop" : null);

  it("says nothing when the press lost nothing", () => {
    expect(
      channelDropSentences({ groupName: "Bộ 5", fromGroup: [], alreadyTicked: [], nameOf: named }),
    ).toBeNull();
  });

  it("never prints a raw id — an id with no Page behind it is COUNTED", () => {
    const text = channelDropSentences({
      groupName: "Bộ 5",
      fromGroup: ["fbpage-7c1d", "fbpage-9a22"],
      alreadyTicked: [],
      nameOf: named,
    });
    expect(text).toBe("Nhóm “Bộ 5” có 2 kênh không còn trong danh sách nên không được tick.");
    expect(text).not.toContain("fbpage-");
  });

  it("names what it can and counts the rest", () => {
    const text = channelDropSentences({
      groupName: "Bộ 5",
      fromGroup: ["ch-lady", "fbpage-7c1d"],
      alreadyTicked: [],
      nameOf: named,
    });
    expect(text).toContain("Lady Fashion và 1 kênh không còn trong danh sách");
    expect(text).not.toContain("fbpage-");
  });

  it("keeps the two facts apart: the group's Pages and the operator's own ticks", () => {
    const text = channelDropSentences({
      groupName: "Bộ 5",
      fromGroup: ["ch-lady"],
      alreadyTicked: ["ch-mysp"],
      nameOf: named,
    });
    expect(text).toContain("Nhóm “Bộ 5” có Lady Fashion");
    expect(text).toContain("MYSP Shop bạn đã tick trước đó");
  });

  it("counts the operator's own lost ticks too when they cannot be named", () => {
    expect(
      channelDropSentences({
        groupName: "Bộ 5",
        fromGroup: [],
        alreadyTicked: ["fbpage-7c1d"],
        nameOf: named,
      }),
    ).toBe("1 kênh bạn đã tick trước đó không còn trong danh sách nên đã bị gỡ khỏi lựa chọn.");
  });

  it("names at most three, then counts the remaining named ones", () => {
    const manyNames = (id: string) => `Page ${id}`;
    const text = channelDropSentences({
      groupName: "Bộ 5",
      fromGroup: ["a", "b", "c", "d", "e"],
      alreadyTicked: [],
      nameOf: manyNames,
    });
    expect(text).toContain("Page a, Page b, Page c và 2 kênh nữa");
  });
});

describe("toggleChannelId", () => {
  it("never mutates the set it was given", () => {
    const applied = new Set(["ch-lady"]);
    const next = toggleChannelId(applied, "ch-mysp", true);
    expect([...applied]).toEqual(["ch-lady"]);
    expect([...next].sort()).toEqual(["ch-lady", "ch-mysp"]);
  });

  it("removes on uncheck", () => {
    expect([...toggleChannelId(new Set(["ch-lady"]), "ch-lady", false)]).toEqual([]);
  });
});

describe("selectAllVisible", () => {
  const list = [
    channel({ channelId: "a" }),
    channel({ channelId: "b" }),
    channel({ channelId: "off", status: "disabled" }),
  ];

  it("ticks every listed Page that can actually be published to", () => {
    expect([...selectAllVisible(new Set(), list)].sort()).toEqual(["a", "b"]);
  });

  it("is scoped to what is on screen — a search must not tick hidden Pages", () => {
    const visible = filterChannels(list, "");
    const searched = visible.filter((item) => item.channelId === "a");
    expect([...selectAllVisible(new Set(), searched)]).toEqual(["a"]);
  });

  it("keeps what was already ticked", () => {
    expect([...selectAllVisible(new Set(["z"]), [channel({ channelId: "a" })])].sort()).toEqual([
      "a",
      "z",
    ]);
  });
});

describe("visibleRows", () => {
  const many = Array.from({ length: 8 }, (_item, index) =>
    channel({ channelId: `ch-${index}` }),
  );

  it("shows everything when the list is short", () => {
    const short = many.slice(0, 3);
    expect(visibleRows(short, false)).toEqual({ rows: short, hidden: 0 });
  });

  it("folds the tail away and counts it for “Xem thêm N page”", () => {
    const result = visibleRows(many, false);
    expect(result.rows).toHaveLength(CHANNEL_ROWS_BEFORE_EXPAND);
    expect(result.hidden).toBe(3);
  });

  it("shows everything once expanded", () => {
    expect(visibleRows(many, true)).toEqual({ rows: many, hidden: 0 });
  });
});

describe("draftOnOpenChange", () => {
  const applied = new Set(["ch-lady"]);
  const draft = new Set(["ch-mysp", "ch-devis"]);

  it("re-seeds from the applied selection when the modal opens", () => {
    const next = draftOnOpenChange({ open: true, wasOpen: false, applied, draft });
    expect([...next]).toEqual(["ch-lady"]);
  });

  it("does NOT touch the applied selection when the modal closes", () => {
    // Escape / click outside: the draft is abandoned, the post keeps what it had.
    const next = draftOnOpenChange({ open: false, wasOpen: true, applied, draft });
    expect(next).toBe(draft);
    expect([...applied]).toEqual(["ch-lady"]);
  });

  it("leaves the draft alone while the modal stays open", () => {
    expect(draftOnOpenChange({ open: true, wasOpen: true, applied, draft })).toBe(draft);
  });

  it("re-opens from the applied selection, not from the abandoned draft", () => {
    const closed = draftOnOpenChange({ open: false, wasOpen: true, applied, draft });
    const reopened = draftOnOpenChange({ open: true, wasOpen: false, applied, draft: closed });
    expect([...reopened]).toEqual(["ch-lady"]);
  });
});

describe("groupPayloadFrom", () => {
  it("builds exactly the body POST /api/channel-groups takes", () => {
    const result = groupPayloadFrom("Bộ 5 page chính", new Set(["ch-lady", "ch-mysp"]));
    expect(result).toEqual({
      ok: true,
      value: { name: "Bộ 5 page chính", channelIds: ["ch-lady", "ch-mysp"] },
    });
  });

  it("refuses an empty name with the server's own sentence", () => {
    const result = groupPayloadFrom("   ", new Set(["ch-lady"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("tên");
  });

  it("refuses a group with no channel", () => {
    const result = groupPayloadFrom("Nhóm rỗng", new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ít nhất một kênh");
  });

  it("trims the name, as the server does", () => {
    const result = groupPayloadFrom("  Miền Bắc  ", new Set(["ch-lady"]));
    expect(result.ok && result.value.name).toBe("Miền Bắc");
  });
});
