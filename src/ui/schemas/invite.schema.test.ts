import { describe, expect, it } from "vitest";

import {
  CreateInviteResponseSchema,
  INVITE_STATUS_LABELS,
  InviteListResponseSchema,
  RevokeInviteResponseSchema,
  inviteStatus,
  inviteUsageLabel,
  isInviteRevocable,
  type Invite,
} from "./invite.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Two things must hold:
 *  - a link that cannot be used must never read as "Đang mở" — an admin would
 *    send it and blame the recipient;
 *  - the url is a credential, so a non-http scheme must fail the parse instead
 *    of reaching an href or the clipboard (core-frontend-security).
 */

/** Recorded from the running API (GET /api/invites) — the real contract. */
const LIVE_INVITE = {
  id: "95a6d9dd-6b5c-4ebc-b6af-3da6548c508d",
  role: "editor",
  expiresAt: "2026-08-27T05:12:47.308Z",
  maxUses: 1,
  usedCount: 0,
  revokedAt: null,
  createdByEmail: "dev@localhost",
};

const BEFORE_EXPIRY = Date.parse("2026-08-20T05:12:47.308Z");
const AFTER_EXPIRY = Date.parse("2026-08-28T05:12:47.308Z");

function invite(overrides: Partial<Invite> = {}): Invite {
  return { ...(LIVE_INVITE as Invite), ...overrides };
}

describe("InviteListResponseSchema", () => {
  it("accepts the payload the API actually returns", () => {
    const parsed = InviteListResponseSchema.safeParse({ items: [LIVE_INVITE] });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty list — a company with no open links is normal", () => {
    expect(InviteListResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("accepts a revoked link: revoked links stay in the list", () => {
    const parsed = InviteListResponseSchema.safeParse({
      items: [{ ...LIVE_INVITE, revokedAt: "2026-08-20T05:13:05.707Z" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("never accepts a url in the list — the server does not send one", () => {
    // Not a schema failure (unknown keys are stripped), but the parsed row must
    // not carry it: a credential has no business in a cached list.
    const parsed = InviteListResponseSchema.parse({
      items: [{ ...LIVE_INVITE, url: "https://mysp.vn/join/leaked" }],
    });
    expect("url" in parsed.items[0]).toBe(false);
  });

  it("rejects a role or a date the UI cannot render", () => {
    expect(
      InviteListResponseSchema.safeParse({ items: [{ ...LIVE_INVITE, role: "superuser" }] }).success,
    ).toBe(false);
    expect(
      InviteListResponseSchema.safeParse({ items: [{ ...LIVE_INVITE, expiresAt: "27/08/2026" }] })
        .success,
    ).toBe(false);
  });
});

describe("CreateInviteResponseSchema", () => {
  const created = {
    id: "95a6d9dd-6b5c-4ebc-b6af-3da6548c508d",
    role: "editor",
    url: "http://localhost:3000/join/c29230bb40c02419fada7bcf376f9128f",
    expiresAt: "2026-08-27T05:12:47.308Z",
  };

  it("accepts the answer the API actually returns", () => {
    expect(CreateInviteResponseSchema.safeParse(created).success).toBe(true);
  });

  it("refuses a url that is not http(s) — it reaches an input and a clipboard", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "ftp://x/join/abc"]) {
      expect(CreateInviteResponseSchema.safeParse({ ...created, url }).success).toBe(false);
    }
  });

  it("refuses an answer with no url — the whole point of this call", () => {
    const { url: _url, ...withoutUrl } = created;
    expect(CreateInviteResponseSchema.safeParse(withoutUrl).success).toBe(false);
  });
});

describe("RevokeInviteResponseSchema", () => {
  it("accepts the answer the API returns, and only a true revoke", () => {
    expect(RevokeInviteResponseSchema.safeParse({ id: "i-1", revoked: true }).success).toBe(true);
    expect(RevokeInviteResponseSchema.safeParse({ id: "i-1", revoked: false }).success).toBe(false);
  });
});

describe("inviteStatus", () => {
  it("calls a fresh, unused link open", () => {
    expect(inviteStatus(invite(), BEFORE_EXPIRY)).toBe("open");
    expect(isInviteRevocable("open")).toBe(true);
  });

  it("puts revoked ahead of every other reason", () => {
    // Someone ACTED on this link; the clock is not the answer the operator needs.
    const revokedAndExpired = invite({ revokedAt: "2026-08-20T05:13:05.707Z" });
    expect(inviteStatus(revokedAndExpired, AFTER_EXPIRY)).toBe("revoked");
  });

  it("calls an expired link expired, including at the exact second", () => {
    expect(inviteStatus(invite(), AFTER_EXPIRY)).toBe("expired");
    expect(inviteStatus(invite(), Date.parse(LIVE_INVITE.expiresAt))).toBe("expired");
  });

  it("never calls an unreadable date 'còn hạn'", () => {
    // A link the server would refuse must not be offered as usable.
    expect(inviteStatus(invite({ expiresAt: "not-a-date" }), BEFORE_EXPIRY)).toBe("expired");
  });

  it("calls a spent link used up", () => {
    expect(inviteStatus(invite({ usedCount: 1, maxUses: 1 }), BEFORE_EXPIRY)).toBe("used_up");
    expect(inviteStatus(invite({ usedCount: 3, maxUses: 5 }), BEFORE_EXPIRY)).toBe("open");
  });

  it("offers revoke only where there is something to take back", () => {
    for (const status of ["revoked", "expired", "used_up"] as const) {
      expect(isInviteRevocable(status)).toBe(false);
      // …and every status the table can show has a Vietnamese label.
      expect(INVITE_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe("inviteUsageLabel", () => {
  it("says how much of the link is left", () => {
    expect(inviteUsageLabel(invite())).toBe("0/1 lượt");
    expect(inviteUsageLabel(invite({ usedCount: 2, maxUses: 5 }))).toBe("2/5 lượt");
  });
});
