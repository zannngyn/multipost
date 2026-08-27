import { describe, expect, it } from "vitest";

import { resolveGroupChannelLabels } from "@/ui/components/channels/channel-group-labels";
import type { Channel } from "@/ui/schemas/channel.schema";

function channel(overrides: Partial<Channel> & { channelId: string }): Channel {
  return {
    platform: "facebook",
    name: "Page A",
    externalId: "1234567890",
    status: "active",
    tokenExpiresAt: null,
    ...overrides,
  };
}

const CHANNELS: readonly Channel[] = [
  channel({ channelId: "c1", name: "Shop Vải Miền Tây" }),
  channel({ channelId: "c2", name: "Kho Sỉ Vải", status: "disabled" }),
  channel({ channelId: "c3", name: "   " }),
];

/**
 * Edge cases first. This is the only thing standing between the operator and a
 * card full of opaque ids — and the dangerous direction is the confident lie:
 * calling a channel "đã gỡ" while the channel list is merely still loading.
 */
describe("resolveGroupChannelLabels", () => {
  it("says nothing about removal while the channel list is unknown", () => {
    // Still loading, or the list request failed: `undefined`, not `[]`.
    expect(resolveGroupChannelLabels(["c1", "nope"], undefined)).toEqual([
      { channelId: "c1", name: null, note: "none" },
      { channelId: "nope", name: null, note: "none" },
    ]);
  });

  it("marks an id the loaded list does not contain as removed", () => {
    expect(resolveGroupChannelLabels(["gone"], CHANNELS)).toEqual([
      { channelId: "gone", name: null, note: "removed" },
    ]);
    // An empty list IS an answer — every id in the group is gone.
    expect(resolveGroupChannelLabels(["c1"], [])).toEqual([
      { channelId: "c1", name: null, note: "removed" },
    ]);
  });

  it("separates 'đã tắt' from 'đã gỡ' — a disabled Page still exists", () => {
    expect(resolveGroupChannelLabels(["c2"], CHANNELS)).toEqual([
      { channelId: "c2", name: "Kho Sỉ Vải", note: "disabled" },
    ]);
  });

  it("names a live Page and keeps the group's order", () => {
    expect(resolveGroupChannelLabels(["c2", "c1"], CHANNELS)).toEqual([
      { channelId: "c2", name: "Kho Sỉ Vải", note: "disabled" },
      { channelId: "c1", name: "Shop Vải Miền Tây", note: "none" },
    ]);
  });

  it("falls back to the same placeholder as the table for a blank name", () => {
    expect(resolveGroupChannelLabels(["c3"], CHANNELS)).toEqual([
      { channelId: "c3", name: "(Page chưa có tên)", note: "none" },
    ]);
  });

  it("never drops an entry, however broken the id is", () => {
    // Business rule 5 at the UI layer: a group of 3 must not render as 2 rows.
    const ids = ["c1", "", "  ", "c1"] as readonly string[];
    const labels = resolveGroupChannelLabels(ids, CHANNELS);
    expect(labels).toHaveLength(4);
    expect(labels[1]).toEqual({ channelId: "", name: null, note: "removed" });
    expect(labels[3]).toEqual({ channelId: "c1", name: "Shop Vải Miền Tây", note: "none" });
  });

  it("returns nothing for a group with no channels", () => {
    expect(resolveGroupChannelLabels([], CHANNELS)).toEqual([]);
  });
});
