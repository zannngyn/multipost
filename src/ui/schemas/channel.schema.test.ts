import { describe, expect, it } from "vitest";

import {
  ChannelImportFormSchema,
  ChannelImportResponseSchema,
  ChannelListResponseSchema,
  RemoveChannelResponseSchema,
  formatImportSummary,
  parseConnectOutcome,
} from "./channel.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Two rules matter here:
 *  - a malformed channel list must FAIL, not half-render: a Page that is not
 *    really connected must never look connected;
 *  - the OAuth callback must never be silently swallowed — every shape the URL
 *    can carry maps to a message the operator can act on.
 */

/** Recorded from the running API (GET /api/channels) — the real contract. */
const LIVE_LIST_PAYLOAD = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  channels: [
    {
      channelId: "fb-page-alpha",
      platform: "facebook",
      name: "MYSP Hàng Thiết Kế",
      externalId: "102938475610293",
      status: "active",
      tokenExpiresAt: "2026-11-30T10:00:00.000Z",
    },
    {
      channelId: "fb-page-beta",
      platform: "facebook",
      name: "MYSP Sỉ Toàn Quốc",
      externalId: "559182736450192",
      status: "disabled",
      tokenExpiresAt: null,
    },
  ],
};

describe("ChannelListResponseSchema", () => {
  it("accepts an empty list — a tenant with no Page is not an error", () => {
    const parsed = ChannelListResponseSchema.safeParse({ tenantId: "t-1", channels: [] });
    expect(parsed.success).toBe(true);
  });

  it("accepts the payload the API actually returns", () => {
    const parsed = ChannelListResponseSchema.safeParse(LIVE_LIST_PAYLOAD);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channels[1]?.tokenExpiresAt).toBeNull();
  });

  it("accepts a blank Page name but never a blank Page id", () => {
    const base = LIVE_LIST_PAYLOAD.channels[0];
    expect(
      ChannelListResponseSchema.safeParse({ tenantId: "t-1", channels: [{ ...base, name: "" }] })
        .success,
    ).toBe(true);
    expect(
      ChannelListResponseSchema.safeParse({
        tenantId: "t-1",
        channels: [{ ...base, externalId: "" }],
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown platform or status instead of rendering it blank", () => {
    const base = LIVE_LIST_PAYLOAD.channels[0];
    expect(
      ChannelListResponseSchema.safeParse({
        tenantId: "t-1",
        channels: [{ ...base, platform: "zalo" }],
      }).success,
    ).toBe(false);
    expect(
      ChannelListResponseSchema.safeParse({
        tenantId: "t-1",
        channels: [{ ...base, status: "paused" }],
      }).success,
    ).toBe(false);
  });

  it("leaves the flag ABSENT when the server withholds it (M3.3)", () => {
    // Field-level: only admin+ receives it. Absent must stay absent rather than
    // become `true` or `false` — the screen decides "no field, no warning", and
    // a default here would hide that decision inside the parser.
    const parsed = ChannelListResponseSchema.safeParse({ tenantId: "t-1", channels: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.secretsConfigured).toBeUndefined();
  });

  it("still refuses a flag that is present but not a boolean", () => {
    expect(
      ChannelListResponseSchema.safeParse({ ...LIVE_LIST_PAYLOAD, secretsConfigured: "yes" })
        .success,
    ).toBe(false);
  });

  it("carries `secretsConfigured: false` through untouched", () => {
    const parsed = ChannelListResponseSchema.safeParse({
      ...LIVE_LIST_PAYLOAD,
      secretsConfigured: false,
    });
    expect(parsed.success && parsed.data.secretsConfigured).toBe(false);
  });

  it("refuses a non-boolean flag rather than guessing what it meant", () => {
    expect(
      ChannelListResponseSchema.safeParse({ tenantId: "t-1", channels: [], secretsConfigured: "no" })
        .success,
    ).toBe(false);
    // "no" is truthy in JS — a lenient parse here would hide a broken server.
    expect(
      ChannelListResponseSchema.safeParse({ tenantId: "t-1", channels: [], secretsConfigured: null })
        .success,
    ).toBe(false);
  });

  it("refuses a channel that leaks an access token field name", () => {
    // Not a security control — a canary. Unknown keys are stripped, so this
    // asserts the CONTRACT stays token-free rather than the transport.
    const parsed = ChannelListResponseSchema.parse({
      tenantId: "t-1",
      channels: [{ ...LIVE_LIST_PAYLOAD.channels[0], accessToken: "secret" }],
    });
    expect(parsed.channels[0]).not.toHaveProperty("accessToken");
  });
});

describe("RemoveChannelResponseSchema", () => {
  it("refuses `removed: false` — a refusal must arrive as an error, not a 200", () => {
    expect(RemoveChannelResponseSchema.safeParse({ channelId: "c-1", removed: false }).success).toBe(
      false,
    );
    expect(RemoveChannelResponseSchema.safeParse({ channelId: "c-1", removed: true }).success).toBe(
      true,
    );
  });
});

describe("ChannelImportResponseSchema", () => {
  it("tolerates a missing `skipped` counter but keeps it when sent", () => {
    const withoutSkipped = ChannelImportResponseSchema.safeParse({
      tenantId: "t-1",
      imported: 1,
      updated: 0,
      channels: [],
    });
    expect(withoutSkipped.success).toBe(true);
    expect(withoutSkipped.success && withoutSkipped.data.skipped).toBeUndefined();

    const withSkipped = ChannelImportResponseSchema.safeParse({
      tenantId: "t-1",
      imported: 1,
      updated: 0,
      skipped: 2,
      channels: [],
    });
    expect(withSkipped.success && withSkipped.data.skipped).toBe(2);
  });

  it("refuses negative or fractional counters", () => {
    expect(
      ChannelImportResponseSchema.safeParse({
        tenantId: "t-1",
        imported: -1,
        updated: 0,
        channels: [],
      }).success,
    ).toBe(false);
    expect(
      ChannelImportResponseSchema.safeParse({
        tenantId: "t-1",
        imported: 1.5,
        updated: 0,
        channels: [],
      }).success,
    ).toBe(false);
  });
});

describe("ChannelImportFormSchema", () => {
  it("refuses an empty box and a box holding only spaces", () => {
    expect(ChannelImportFormSchema.safeParse({ userAccessToken: "" }).success).toBe(false);
    expect(ChannelImportFormSchema.safeParse({ userAccessToken: "   " }).success).toBe(false);
  });

  it("refuses a whole sentence pasted by accident", () => {
    const parsed = ChannelImportFormSchema.safeParse({ userAccessToken: "token la EAAG123" });
    expect(parsed.success).toBe(false);
  });

  it("trims the newline a copy-paste leaves behind", () => {
    const parsed = ChannelImportFormSchema.safeParse({ userAccessToken: "  EAAGabc123\n" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.userAccessToken).toBe("EAAGabc123");
  });
});

describe("parseConnectOutcome", () => {
  it("returns nothing for a normal visit", () => {
    expect(parseConnectOutcome(new URLSearchParams(""))).toBeNull();
    expect(parseConnectOutcome(null)).toBeNull();
    expect(parseConnectOutcome(undefined)).toBeNull();
  });

  it("reads the count the callback sends, extra params and all", () => {
    expect(parseConnectOutcome(new URLSearchParams("connected=2&new=1"))).toEqual({
      kind: "connected",
      count: 2,
    });
    expect(parseConnectOutcome(new URLSearchParams("connected=0"))).toEqual({
      kind: "connected",
      count: 0,
    });
  });

  it("still reports success when the count is unreadable", () => {
    // The round trip DID happen; dropping the message would hide that.
    expect(parseConnectOutcome(new URLSearchParams("connected=abc"))).toEqual({
      kind: "connected",
      count: null,
    });
    expect(parseConnectOutcome(new URLSearchParams("connected=-3"))).toEqual({
      kind: "connected",
      count: null,
    });
  });

  it("treats a cancelled consent screen as its own outcome, not an error", () => {
    expect(parseConnectOutcome(new URLSearchParams("connect=cancelled"))).toEqual({
      kind: "cancelled",
    });
  });

  it("keeps the error reason but strips anything unprintable from it", () => {
    expect(parseConnectOutcome(new URLSearchParams("connect=error&reason=STATE_MISMATCH"))).toEqual({
      kind: "error",
      reason: "STATE_MISMATCH",
    });
    expect(
      parseConnectOutcome(new URLSearchParams("connect=error&reason=<script>alert(1)</script>")),
    ).toEqual({ kind: "error", reason: "scriptalert1script" });
    expect(parseConnectOutcome(new URLSearchParams("connect=error"))).toEqual({
      kind: "error",
      reason: null,
    });
  });

  it("does not swallow an outcome it has never seen", () => {
    expect(parseConnectOutcome(new URLSearchParams("connect=whatever"))).toEqual({
      kind: "error",
      reason: null,
    });
  });
});

describe("formatImportSummary", () => {
  it("says nothing changed instead of showing two zeroes", () => {
    expect(formatImportSummary({ imported: 0, updated: 0 })).toBe(
      "Không có Page nào thay đổi — danh sách đã khớp với Facebook.",
    );
  });

  it("reports the real numbers", () => {
    expect(formatImportSummary({ imported: 2, updated: 1 })).toBe(
      "Đã thêm 2 Page, cập nhật 1 Page.",
    );
  });

  it("never leaves a skipped Page unmentioned", () => {
    expect(formatImportSummary({ imported: 1, updated: 0, skipped: 2 })).toContain("Bỏ qua 2 Page");
    expect(formatImportSummary({ imported: 1, updated: 0, skipped: 0 })).not.toContain("Bỏ qua");
  });
});
