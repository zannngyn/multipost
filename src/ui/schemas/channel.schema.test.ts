import { describe, expect, it } from "vitest";

import {
  ChannelImportFormSchema,
  ChannelImportResponseSchema,
  ChannelListResponseSchema,
  RemoveChannelResponseSchema,
  UNREADABLE_COUNT,
  connectSuccessView,
  formatImportSummary,
  parseConnectOutcome,
  type SkippedCount,
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

  it("reads all three counters the callback sends", () => {
    // `?connected=N&new=X&skipped=Y` — the exact string
    // `app/api/channels/callback/route.ts` redirects with.
    expect(parseConnectOutcome(new URLSearchParams("connected=2&new=1&skipped=3"))).toEqual({
      kind: "connected",
      count: 2,
      newCount: 1,
      skipped: 3,
    });
    // Zero is a real answer and must not collapse into "không biết".
    expect(parseConnectOutcome(new URLSearchParams("connected=0&new=0&skipped=0"))).toEqual({
      kind: "connected",
      count: 0,
      newCount: 0,
      skipped: 0,
    });
  });

  it("says 'không biết' rather than zero when a counter is absent", () => {
    // An older callback, or a hand-typed URL: claiming "0 Page bị bỏ qua" from
    // a param nobody sent would be inventing a fact.
    expect(parseConnectOutcome(new URLSearchParams("connected=2&new=1"))).toEqual({
      kind: "connected",
      count: 2,
      newCount: 1,
      skipped: null,
    });
    expect(parseConnectOutcome(new URLSearchParams("connected=0"))).toEqual({
      kind: "connected",
      count: 0,
      newCount: null,
      skipped: null,
    });
  });

  it("tells an absent `skipped` apart from one it could not read", () => {
    // Two different silences: nobody sent a number, vs somebody sent rubbish.
    // Rounding the second down to "không có Page nào bị bỏ qua" would hide the
    // exact fact business rule 5 exists to surface.
    const skippedOf = (search: string): SkippedCount => {
      const outcome = parseConnectOutcome(new URLSearchParams(search));
      // A failed narrowing here would mean the whole outcome changed shape.
      if (outcome?.kind !== "connected") throw new Error(`not a connected outcome: ${search}`);
      return outcome.skipped;
    };

    expect(skippedOf("connected=2&skipped=x")).toBe(UNREADABLE_COUNT);
    expect(skippedOf("connected=2&skipped=-1")).toBe(UNREADABLE_COUNT);
    expect(skippedOf("connected=2&skipped=")).toBe(UNREADABLE_COUNT);
    expect(skippedOf("connected=2")).toBeNull();
    expect(skippedOf("connected=2&skipped=0")).toBe(0);
  });

  it("ignores counters without a `connected` of their own", () => {
    // Counts alone are not an outcome — nothing came back from Facebook here.
    expect(parseConnectOutcome(new URLSearchParams("new=1&skipped=3"))).toBeNull();
  });

  it("still reports success when a counter is unreadable", () => {
    // The round trip DID happen; dropping the message would hide that.
    expect(parseConnectOutcome(new URLSearchParams("connected=abc"))).toEqual({
      kind: "connected",
      count: null,
      newCount: null,
      skipped: null,
    });
    expect(parseConnectOutcome(new URLSearchParams("connected=-3"))).toEqual({
      kind: "connected",
      count: null,
      newCount: null,
      skipped: null,
    });
    // Digits-only: "3.7" and "3 quả" are not counts, and parseInt would have
    // happily read both as 3.
    expect(parseConnectOutcome(new URLSearchParams("connected=3.7&new=3abc&skipped=%20"))).toEqual({
      kind: "connected",
      count: null,
      newCount: null,
      // `skipped=` WAS sent here, just not as a number — not the same silence.
      skipped: UNREADABLE_COUNT,
    });
    // Beyond Number.MAX_SAFE_INTEGER the value is no longer the number sent.
    expect(
      parseConnectOutcome(new URLSearchParams("connected=99999999999999999999&skipped=2")),
    ).toEqual({ kind: "connected", count: null, newCount: null, skipped: 2 });
  });

  it("keeps a broken counter from poisoning the ones next to it", () => {
    expect(parseConnectOutcome(new URLSearchParams("connected=2&new=x&skipped=3"))).toEqual({
      kind: "connected",
      count: 2,
      newCount: null,
      skipped: 3,
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

describe("connectSuccessView", () => {
  function view(count: number | null, newCount: number | null, skipped: SkippedCount) {
    return connectSuccessView({ kind: "connected", count, newCount, skipped });
  }

  // Edge cases first: every one of these is a number the callback may not have
  // sent, or may have sent as zero.
  it("never leaves a skipped Page unsaid, and turns the banner into a warning", () => {
    const result = view(2, 1, 3);
    expect(result.tone).toBe("warning");
    // Business rule 5: the answer to "vì sao Page X không có trong danh sách"
    // has to be on screen, with a number and somewhere to go looking — and in
    // the TITLE, which is the part read first and sometimes the only part read.
    expect(result.title).toBe("Đã nhập 2 Page (1 mới) · 3 Page bị bỏ qua");
    expect(result.description).toContain("3 Page bị bỏ qua");
    expect(result.description).toContain("thiếu quyền");
    expect(result.description).toContain("tài khoản Facebook");
  });

  it("stays a success and says nothing about skipping when nothing was skipped", () => {
    for (const skipped of [0, null] as const) {
      const result = view(2, 1, skipped);
      expect(result.tone).toBe("success");
      expect(result.title).toBe("Đã nhập 2 Page (1 mới)");
      expect(result.description).not.toContain("bỏ qua");
    }
  });

  it("says so out loud when the skipped counter itself was unreadable", () => {
    // NOT the same as "không có Page nào bị bỏ qua": a Page may well have been
    // dropped, and silence here is exactly the hole rule 5 closes.
    const result = view(2, 1, UNREADABLE_COUNT);
    expect(result.tone).toBe("warning");
    expect(result.description).toContain("Không đọc được số Page bị bỏ qua");
    expect(result.description).toContain("tài khoản Facebook");
    // No invented number, in either half of the banner.
    expect(result.description).not.toContain("0 Page bị bỏ qua");
    expect(result.title).toBe("Đã nhập 2 Page (1 mới)");
  });

  it("warns in words, not only in colour", () => {
    // A warning tone with a success sentence would leave colour as the only
    // signal (core-accessibility: named status).
    expect(view(2, 1, 3).description).toContain("bỏ qua");
    expect(view(0, 0, 4).description).toContain("bỏ qua");
    expect(view(2, 1, UNREADABLE_COUNT).description).toContain("bỏ qua");
  });

  it("counts both the total and the genuinely new Pages", () => {
    expect(view(2, 1, 0).title).toBe("Đã nhập 2 Page (1 mới)");
    // Everything Facebook returned was already connected.
    expect(view(2, 0, 0).title).toBe("Đã cập nhật 2 Page, không có Page mới");
    // An older callback that sends no `new=`: do not guess how many were new.
    expect(view(2, null, null).title).toBe("Đã nhập 2 Page");
  });

  it("does not show a count it could not read", () => {
    expect(view(null, null, null).title).toBe("Đã kết nối xong với Facebook");
    // Unreadable total, readable skipped — the warning still has to land.
    const result = view(null, null, 2);
    expect(result.tone).toBe("warning");
    expect(result.description).toContain("2 Page bị bỏ qua");
    expect(result.title).toBe("Đã kết nối xong với Facebook · 2 Page bị bỏ qua");
  });

  it("keeps a counter it CAN read when the one beside it is broken", () => {
    // `?connected=abc&new=3`: dropping "3 Page mới" because the total was
    // unreadable would throw away the only number that survived.
    expect(view(null, 3, 0).title).toBe("Đã kết nối xong với Facebook (3 Page mới)");
    expect(view(null, 0, null).title).toBe("Đã kết nối xong với Facebook, không có Page mới");
    expect(view(null, 3, 2).title).toBe(
      "Đã kết nối xong với Facebook (3 Page mới) · 2 Page bị bỏ qua",
    );
  });

  it("says nothing changed instead of announcing zero Pages", () => {
    expect(view(0, 0, 0).title).toBe("Không có Page nào thay đổi");
    expect(view(0, null, null).title).toBe("Không có Page nào thay đổi");
  });

  it("always points at the tab where the Pages can be checked", () => {
    for (const result of [view(2, 1, 0), view(0, 0, 0), view(null, null, 3)]) {
      expect(result.description).toContain("Page đã kết nối");
    }
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
      "Đã nhập 2 Page, cập nhật 1 Page.",
    );
  });

  it("never leaves a skipped Page unmentioned", () => {
    expect(formatImportSummary({ imported: 1, updated: 0, skipped: 2 })).toContain(
      "2 Page bị bỏ qua",
    );
    expect(formatImportSummary({ imported: 1, updated: 0, skipped: 0 })).not.toContain("bỏ qua");
  });

  // Spec §3.5, the reason this test exists at all: the two doors into "Kênh"
  // (pasted token here, OAuth in `connectSuccessView`) drifted into two voices.
  // Pinning the shared words is what stops the next edit to one door from
  // re-opening the gap — a reviewer cannot see both files at once.
  it("speaks the same words as the OAuth door", () => {
    const pasted = formatImportSummary({ imported: 2, updated: 1, skipped: 3 });
    const oauth = connectSuccessView({ kind: "connected", count: 2, newCount: 1, skipped: 3 });

    // Same verb for "these Pages are now in the tool".
    expect(pasted).toContain("Đã nhập 2 Page");
    expect(oauth.title).toContain("Đã nhập 2 Page");

    // Same skeleton for a refused Page: "N Page bị bỏ qua — <lý do>".
    expect(pasted).toContain("3 Page bị bỏ qua — ");
    expect(`${oauth.title} ${oauth.description}`).toContain("3 Page bị bỏ qua");
    expect(oauth.description).toContain("3 Page bị bỏ qua — ");

    // Both send the operator to the same place to check.
    expect(pasted).toContain("tài khoản Facebook");
    expect(oauth.description).toContain("tài khoản Facebook");
  });
});
