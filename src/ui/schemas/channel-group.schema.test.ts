import { describe, expect, it } from "vitest";

import {
  ChannelGroupFormSchema,
  formatChannelIds,
  parseChannelIds,
} from "./channel-group.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that matters here:
 * an empty group must never reach the server as "valid" — it would produce a
 * post batch with zero channels, i.e. a click that does nothing silently.
 */

describe("parseChannelIds", () => {
  it("returns nothing for blank input", () => {
    expect(parseChannelIds("")).toEqual([]);
    expect(parseChannelIds("   \n , \n ")).toEqual([]);
    expect(parseChannelIds(undefined as never)).toEqual([]);
  });

  it("splits on newlines and commas, trims and drops duplicates", () => {
    expect(parseChannelIds(" facebook , page-2\nfacebook\n\npage-3 ")).toEqual([
      "facebook",
      "page-2",
      "page-3",
    ]);
  });

  it("round-trips with the formatter used to prefill the edit form", () => {
    const ids = ["facebook", "page-2"];
    expect(parseChannelIds(formatChannelIds(ids))).toEqual(ids);
  });
});

describe("ChannelGroupFormSchema", () => {
  it("refuses a group without a name", () => {
    const parsed = ChannelGroupFormSchema.safeParse({ name: "  ", channelIdsText: "facebook" });
    expect(parsed.success).toBe(false);
  });

  it("refuses a group whose channel list is only separators", () => {
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIdsText: " , , " });
    expect(parsed.success).toBe(false);
  });

  it("refuses more channels than the domain allows", () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `page-${index}`).join("\n");
    const parsed = ChannelGroupFormSchema.safeParse({ name: "Nhóm A", channelIdsText: tooMany });
    expect(parsed.success).toBe(false);
  });

  it("accepts a normal group", () => {
    const parsed = ChannelGroupFormSchema.safeParse({
      name: "  Fanpage chính ",
      channelIdsText: "facebook\npage-2",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe("Fanpage chính");
  });
});
