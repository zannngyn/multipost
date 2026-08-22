import { describe, expect, it } from "vitest";

import {
  ChannelGroupFormSchema,
  MAX_CHANNELS_PER_GROUP,
  uniqueChannelIds,
} from "./channel-group.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that matters here:
 * an empty group must never reach the server as "valid" — it would produce a
 * post batch with zero channels, i.e. a click that does nothing silently.
 */

describe("uniqueChannelIds", () => {
  it("keeps the first occurrence and the ticking order", () => {
    expect(uniqueChannelIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("survives an empty list", () => {
    expect(uniqueChannelIds([])).toEqual([]);
  });
});

describe("ChannelGroupFormSchema", () => {
  it("refuses a group without a name", () => {
    const parsed = ChannelGroupFormSchema.safeParse({ name: "  ", channelIds: ["ch-1"] });
    expect(parsed.success).toBe(false);
  });

  it("refuses a group with no channel ticked", () => {
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIds: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toBe(
      "Nhóm kênh phải có ít nhất một kênh.",
    );
  });

  it("refuses a channel id that is an empty string", () => {
    // A blank value can only come from a broken option, never from a real tick.
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIds: [""] });
    expect(parsed.success).toBe(false);
  });

  it("refuses more channels than the domain allows", () => {
    const tooMany = Array.from({ length: MAX_CHANNELS_PER_GROUP + 1 }, (_, i) => `page-${i}`);
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIds: tooMany });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toBe(
      `Một nhóm kênh chỉ chứa tối đa ${MAX_CHANNELS_PER_GROUP} kênh.`,
    );
  });

  it("drops a repeated channel instead of fanning out to it twice", () => {
    const parsed = ChannelGroupFormSchema.safeParse({
      name: "Nhóm A",
      channelIds: ["ch-1", "ch-2", "ch-1"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channelIds).toEqual(["ch-1", "ch-2"]);
  });

  it("counts duplicates once against the maximum", () => {
    // 50 distinct + one repeat is still 50 channels, not 51.
    const atLimit = Array.from({ length: MAX_CHANNELS_PER_GROUP }, (_, i) => `page-${i}`);
    const parsed = ChannelGroupFormSchema.safeParse({
      name: "Nhóm A",
      channelIds: [...atLimit, "page-0"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channelIds).toHaveLength(MAX_CHANNELS_PER_GROUP);
  });

  it("accepts exactly the maximum", () => {
    const atLimit = Array.from({ length: MAX_CHANNELS_PER_GROUP }, (_, i) => `page-${i}`);
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIds: atLimit });
    expect(parsed.success).toBe(true);
  });

  it("accepts a normal group and trims the name", () => {
    const parsed = ChannelGroupFormSchema.safeParse({
      name: "  Page chính ",
      channelIds: ["ch-1", "ch-2"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe("Page chính");
    expect(parsed.success && parsed.data.channelIds).toEqual(["ch-1", "ch-2"]);
  });
});
