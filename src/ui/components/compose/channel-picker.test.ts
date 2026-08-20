import { describe, expect, it } from "vitest";

import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

import {
  CHANNEL_ROWS_BEFORE_EXPAND,
  avatarToneVar,
  channelBlockReason,
  channelInitials,
  draftOnOpenChange,
  filterChannels,
  groupPayloadFrom,
  matchingGroupId,
  publishableChannels,
  selectAllVisible,
  selectionForGroup,
  toggleChannelId,
  visibleRows,
} from "./channel-picker";

/**
 * Rules of the "Chọn kênh đăng" modal. Every test here answers one question:
 * WHICH Fanpages is this post about to go to? A wrong answer is a post on the
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

  it("always names a variable that exists in compose-theme", () => {
    for (const name of ["Lady Fashion", "Mys.P", "", "Devis", "Charmia"]) {
      expect(avatarToneVar(name)).toMatch(/^var\(--compose-avatar-[0-4]\)$/);
    }
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

describe("selectionForGroup", () => {
  const available = [channel({ channelId: "ch-lady" }), channel({ channelId: "ch-mysp" })];

  it("ticks exactly the group's channels", () => {
    expect(selectionForGroup(group(), available)).toEqual({
      selected: ["ch-lady", "ch-mysp"],
      dropped: [],
    });
  });

  it("REPLACES rather than adds — the lit pill must not lie", () => {
    const one = selectionForGroup(group({ channelIds: ["ch-mysp"] }), available);
    expect(one.selected).toEqual(["ch-mysp"]);
  });

  it("drops a channel the tenant no longer owns, and says which", () => {
    const stale = group({ channelIds: ["ch-lady", "ch-gone"] });
    expect(selectionForGroup(stale, available)).toEqual({
      selected: ["ch-lady"],
      dropped: ["ch-gone"],
    });
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
