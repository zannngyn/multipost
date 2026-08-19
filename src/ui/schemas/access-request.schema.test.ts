import { describe, expect, it } from "vitest";

import {
  AccessDecisionResponseSchema,
  AccessRequestListResponseSchema,
  DEFAULT_ACCESS_FILTER_STATUS,
  accessRequestDisplayName,
  accessRequestEmailLabel,
  accessSearchParams,
  hasEmail,
  parseAccessFilterStatus,
} from "./access-request.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Two things must hold:
 *  - a malformed access list FAILS instead of half-rendering: a request that
 *    was never decided must not appear decided, and vice versa;
 *  - a missing e-mail is a NORMAL answer from Facebook, so it must survive the
 *    parse and come out as a sentence, never as the string "null".
 */

/** The payload shape agreed with the API (GET /api/access-requests). */
const PENDING_ROW = {
  id: "3f2a9d1e-0c1b-4a55-9d31-6b8a1f0c2e77",
  provider: "facebook",
  providerAccountId: "992710700450296",
  displayName: "Nguyen Van A",
  email: null,
  status: "pending",
  role: null,
  requestedAt: "2026-08-19T03:21:45.000Z",
  decidedAt: null,
  decidedByEmail: null,
};

const APPROVED_ROW = {
  id: "8c4e1b70-91d2-4f0a-a0f2-7d3c5e9b1a02",
  provider: "google",
  providerAccountId: "108273645019283746501",
  displayName: "Trần Thị B",
  email: "b@mysp.vn",
  status: "approved",
  role: "editor",
  requestedAt: "2026-08-18T09:00:00+07:00",
  decidedAt: "2026-08-18T10:15:00+07:00",
  decidedByEmail: "admin@mysp.vn",
};

describe("AccessRequestListResponseSchema", () => {
  it("accepts an empty list — nobody waiting is not an error", () => {
    expect(AccessRequestListResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("accepts a request with no e-mail (Facebook does not always send one)", () => {
    const parsed = AccessRequestListResponseSchema.safeParse({ items: [PENDING_ROW] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]?.email).toBeNull();
  });

  it("accepts a decided row with an offset timestamp", () => {
    const parsed = AccessRequestListResponseSchema.safeParse({ items: [APPROVED_ROW] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]?.role).toBe("editor");
  });

  it("accepts a blank or absent display name but never a blank account id", () => {
    expect(
      AccessRequestListResponseSchema.safeParse({ items: [{ ...PENDING_ROW, displayName: "" }] })
        .success,
    ).toBe(true);
    // The API's own view type is `string | null` — a nameless Facebook account
    // must still reach the admin, not blank the whole queue.
    expect(
      AccessRequestListResponseSchema.safeParse({ items: [{ ...PENDING_ROW, displayName: null }] })
        .success,
    ).toBe(true);
    expect(
      AccessRequestListResponseSchema.safeParse({
        items: [{ ...PENDING_ROW, providerAccountId: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a status or role the screen cannot render", () => {
    expect(
      AccessRequestListResponseSchema.safeParse({ items: [{ ...PENDING_ROW, status: "waiting" }] })
        .success,
    ).toBe(false);
    expect(
      AccessRequestListResponseSchema.safeParse({ items: [{ ...APPROVED_ROW, role: "superuser" }] })
        .success,
    ).toBe(false);
  });

  it("rejects a missing e-mail FIELD — only an explicit null means 'no e-mail'", () => {
    const { email: _email, ...withoutEmail } = PENDING_ROW;
    expect(AccessRequestListResponseSchema.safeParse({ items: [withoutEmail] }).success).toBe(
      false,
    );
  });

  it("rejects an unparseable requestedAt instead of showing an invalid date", () => {
    expect(
      AccessRequestListResponseSchema.safeParse({
        items: [{ ...PENDING_ROW, requestedAt: "19/08/2026" }],
      }).success,
    ).toBe(false);
  });
});

describe("AccessDecisionResponseSchema", () => {
  it("accepts a block, which carries no role", () => {
    const parsed = AccessDecisionResponseSchema.safeParse({ id: "x", status: "blocked" });
    expect(parsed.success).toBe(true);
  });

  it("accepts an approval with the granted role", () => {
    const parsed = AccessDecisionResponseSchema.safeParse({
      id: "x",
      status: "approved",
      role: "viewer",
    });
    expect(parsed.success && parsed.data.role).toBe("viewer");
  });

  it("rejects an answer without the new status — the screen would guess", () => {
    expect(AccessDecisionResponseSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("parseAccessFilterStatus", () => {
  it("falls back to 'chờ duyệt' when the URL says nothing", () => {
    expect(parseAccessFilterStatus(new URLSearchParams())).toBe(DEFAULT_ACCESS_FILTER_STATUS);
  });

  it("falls back instead of crashing on a hand-edited URL", () => {
    expect(parseAccessFilterStatus(new URLSearchParams("status=nonsense"))).toBe("pending");
  });

  it("reads every filter the screen offers", () => {
    expect(parseAccessFilterStatus(new URLSearchParams("status=all"))).toBe("all");
    expect(parseAccessFilterStatus(new URLSearchParams("status=blocked"))).toBe("blocked");
  });
});

describe("accessSearchParams", () => {
  it("leaves the default out of the URL", () => {
    expect(accessSearchParams("pending").toString()).toBe("");
  });

  it("round-trips every non-default filter", () => {
    for (const status of ["approved", "blocked", "all"] as const) {
      const params = new URLSearchParams(accessSearchParams(status).toString());
      expect(parseAccessFilterStatus(params)).toBe(status);
    }
  });
});

describe("display helpers", () => {
  it("never renders an anonymous row: falls back to the e-mail, then to a label", () => {
    expect(accessRequestDisplayName({ displayName: "  ", email: "b@mysp.vn" })).toBe("b@mysp.vn");
    expect(accessRequestDisplayName({ displayName: "", email: null })).toBe("(chưa có tên)");
    expect(accessRequestDisplayName({ displayName: null, email: null })).toBe("(chưa có tên)");
    expect(accessRequestDisplayName({ displayName: " Nguyen Van A ", email: null })).toBe(
      "Nguyen Van A",
    );
  });

  it("says 'no e-mail' out loud instead of printing null", () => {
    expect(accessRequestEmailLabel(null)).toBe("Không có email");
    expect(accessRequestEmailLabel("   ")).toBe("Không có email");
    expect(accessRequestEmailLabel("b@mysp.vn")).toBe("b@mysp.vn");
    expect(hasEmail(null)).toBe(false);
    expect(hasEmail(" ")).toBe(false);
    expect(hasEmail("b@mysp.vn")).toBe(true);
  });
});
