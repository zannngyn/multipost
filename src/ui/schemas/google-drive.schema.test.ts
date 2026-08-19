import { describe, expect, it } from "vitest";

import {
  DriveFolderPageSchema,
  DriveSpreadsheetPageSchema,
  GOOGLE_DRIVE_ROOT_ID,
  GOOGLE_DRIVE_ROOT_NAME,
  GoogleConnectionSchema,
  SpreadsheetTabsSchema,
  currentFolder,
  driveItemLabel,
  formatConnectedAt,
  googleConnectErrorMessage,
  parseGoogleConnectOutcome,
  sourceAccessWarning,
} from "./google-drive.schema";

/**
 * Edge cases first (CLAUDE.md §1): a hostile query string, a payload missing
 * the fields the picker navigates by, an unparseable date. The happy paths are
 * at the end because they are the ones that already work by accident.
 */

describe("parseGoogleConnectOutcome", () => {
  it("returns null when the URL carries no callback at all", () => {
    expect(parseGoogleConnectOutcome(new URLSearchParams(""))).toBeNull();
    expect(parseGoogleConnectOutcome(new URLSearchParams("tenantId=abc"))).toBeNull();
    expect(parseGoogleConnectOutcome(null)).toBeNull();
    expect(parseGoogleConnectOutcome(undefined)).toBeNull();
  });

  it("treats an unknown value as an error rather than swallowing it", () => {
    expect(parseGoogleConnectOutcome(new URLSearchParams("google=whatever"))).toEqual({
      kind: "error",
      reason: null,
    });
  });

  it("strips anything unprintable out of the reason code", () => {
    expect(
      parseGoogleConnectOutcome(
        new URLSearchParams("google=error&reason=<script>alert(1)</script>"),
      ),
    ).toEqual({ kind: "error", reason: "scriptalert1script" });
  });

  it("caps a very long reason so it cannot flood the notice", () => {
    const outcome = parseGoogleConnectOutcome(
      new URLSearchParams(`google=error&reason=${"A".repeat(500)}`),
    );
    expect(outcome).toEqual({ kind: "error", reason: "A".repeat(64) });
  });

  it("keeps an empty reason as null instead of an empty badge", () => {
    expect(parseGoogleConnectOutcome(new URLSearchParams("google=error&reason=%20"))).toEqual({
      kind: "error",
      reason: null,
    });
  });

  it("reads the three outcomes the callback can send", () => {
    expect(parseGoogleConnectOutcome(new URLSearchParams("google=connected"))).toEqual({
      kind: "connected",
    });
    expect(parseGoogleConnectOutcome(new URLSearchParams("google=cancelled"))).toEqual({
      kind: "cancelled",
    });
    expect(
      parseGoogleConnectOutcome(new URLSearchParams("google=error&reason=GOOGLE_AUTH_EXPIRED")),
    ).toEqual({ kind: "error", reason: "GOOGLE_AUTH_EXPIRED" });
  });
});

describe("googleConnectErrorMessage", () => {
  it("still says something useful for an unknown code", () => {
    const message = googleConnectErrorMessage("SOMETHING_NEW");
    expect(message).toContain("kết nối lại");
    expect(message).not.toBe("");
  });

  it("has a message when there is no code at all", () => {
    expect(googleConnectErrorMessage(null)).toContain("kết nối lại");
  });

  /**
   * The callback puts an AppError.code in `reason`, so these are the codes it
   * can actually send. A code that falls through to the generic sentence is a
   * gap in the map, not a feature.
   */
  it.each([
    ["GOOGLE_CONNECT_STATE_INVALID", "cookie"],
    ["GOOGLE_AUTH_EXPIRED", "quyền"],
    ["GOOGLE_OAUTH_NOT_CONFIGURED", "OAuth"],
    ["INVALID_INPUT", "mã đơn vị"],
    ["DRIVE_ERROR", "Google"],
    ["DB_ERROR", "lưu"],
    ["INTERNAL", "sự cố"],
  ])("explains %s in its own words", (code, fragment) => {
    const message = googleConnectErrorMessage(code);
    expect(message).toContain(fragment);
    expect(message).not.toBe(googleConnectErrorMessage("SOMETHING_NEW"));
  });

  it("no longer pretends to know codes the callback cannot send", () => {
    // The user cancelling leaves via ?google=cancelled, the state branches now
    // answer GOOGLE_CONNECT_STATE_INVALID, and GOOGLE_NOT_CONNECTED belongs to
    // the browse endpoints — none of them can arrive here.
    const generic = googleConnectErrorMessage("SOMETHING_NEW");
    for (const dead of ["STATE_MISMATCH", "ACCESS_DENIED", "GOOGLE_NOT_CONNECTED"]) {
      expect(googleConnectErrorMessage(dead)).toBe(generic);
    }
  });
});

describe("sourceAccessWarning", () => {
  it("says nothing when there is nothing to warn about", () => {
    // `no_source`: nothing stored yet. `unknown`: the check did not conclude —
    // inventing a warning there would train the operator to ignore the real one.
    expect(sourceAccessWarning("ok")).toBeNull();
    expect(sourceAccessWarning("no_source")).toBeNull();
    expect(sourceAccessWarning("unknown")).toBeNull();
  });

  it("names the folder when only Drive is unreadable", () => {
    const warning = sourceAccessWarning("drive_unreadable");
    expect(warning?.message).toContain("thư mục ảnh");
    expect(warning?.message).not.toContain("Google Sheet");
    expect(warning?.message).toContain("Đồng bộ sẽ dừng");
    expect(warning?.actionLabel).toBe("Chọn lại thư mục và bảng");
  });

  it("names the spreadsheet when only the Sheet is unreadable", () => {
    const warning = sourceAccessWarning("spreadsheet_unreadable");
    expect(warning?.message).toContain("bảng Google Sheet");
    expect(warning?.message).not.toContain("thư mục ảnh");
  });

  it("names both when neither can be read", () => {
    const warning = sourceAccessWarning("both_unreadable");
    expect(warning?.message).toContain("thư mục ảnh");
    expect(warning?.message).toContain("bảng Google Sheet");
  });
});

describe("GoogleConnectionSchema", () => {
  it("rejects a connected payload with no account on it", () => {
    // Without an email the panel could not tell WHICH Google account is in use.
    expect(
      GoogleConnectionSchema.safeParse({
        state: "connected",
        connectedAt: "x",
        scopes: [],
        sourceAccess: "ok",
      }).success,
    ).toBe(false);
  });

  it("rejects a connected payload without sourceAccess", () => {
    // A missing key means the server never checked whether this account can
    // read the stored source — the panel must not vouch for it silently.
    expect(
      GoogleConnectionSchema.safeParse({
        state: "connected",
        email: "a@b.com",
        connectedAt: "2026-08-19T03:00:00.000Z",
        scopes: [],
      }).success,
    ).toBe(false);
  });

  it("degrades an unrecognised sourceAccess to unknown instead of blanking the panel", () => {
    const parsed = GoogleConnectionSchema.parse({
      state: "connected",
      email: "a@b.com",
      connectedAt: "2026-08-19T03:00:00.000Z",
      scopes: [],
      sourceAccess: "something_new",
    });
    expect(parsed).toMatchObject({ state: "connected", sourceAccess: "unknown" });
  });

  it("keeps a real access verdict so the warning can be shown", () => {
    const parsed = GoogleConnectionSchema.parse({
      state: "connected",
      email: "a@b.com",
      connectedAt: "2026-08-19T03:00:00.000Z",
      scopes: [],
      sourceAccess: "drive_unreadable",
    });
    expect(parsed).toMatchObject({ sourceAccess: "drive_unreadable" });
  });

  it("rejects an unknown state instead of guessing", () => {
    expect(GoogleConnectionSchema.safeParse({ state: "maybe" }).success).toBe(false);
  });

  it("keeps expired apart from not_connected", () => {
    const parsed = GoogleConnectionSchema.parse({
      state: "expired",
      email: "a@b.com",
      connectedAt: "2026-08-19T03:00:00.000Z",
      reason: "GOOGLE_AUTH_EXPIRED",
    });
    expect(parsed.state).toBe("expired");
  });

  it("accepts the three shapes the API promises", () => {
    expect(GoogleConnectionSchema.parse({ state: "not_connected" }).state).toBe("not_connected");
    expect(
      GoogleConnectionSchema.parse({
        state: "connected",
        email: "a@b.com",
        connectedAt: "2026-08-19T03:00:00.000Z",
        scopes: ["drive.readonly"],
        sourceAccess: "ok",
      }).state,
    ).toBe("connected");
  });
});

describe("DriveFolderPageSchema", () => {
  it("rejects an item without an id — an unopenable row", () => {
    expect(
      DriveFolderPageSchema.safeParse({
        items: [{ name: "Ảnh" }],
        nextPageToken: null,
        breadcrumb: [],
      }).success,
    ).toBe(false);
  });

  it("treats a missing nextPageToken as the last page", () => {
    const page = DriveFolderPageSchema.parse({ items: [], breadcrumb: [] });
    expect(page.nextPageToken).toBeNull();
  });

  it("keeps a real page token", () => {
    const page = DriveFolderPageSchema.parse({
      items: [{ id: "1abc", name: "Ảnh sản phẩm" }],
      nextPageToken: "tok",
      breadcrumb: [{ id: "root", name: "Drive của tôi" }],
    });
    expect(page.nextPageToken).toBe("tok");
    expect(page.items).toHaveLength(1);
  });
});

describe("DriveSpreadsheetPageSchema", () => {
  it("normalises a null token", () => {
    expect(DriveSpreadsheetPageSchema.parse({ items: [], nextPageToken: null }).nextPageToken).toBe(
      null,
    );
  });
});

describe("SpreadsheetTabsSchema", () => {
  it("rejects a nameless tab — it could not be selected", () => {
    expect(SpreadsheetTabsSchema.safeParse({ tabs: [""] }).success).toBe(false);
  });

  it("accepts an ordered list of tab names", () => {
    expect(SpreadsheetTabsSchema.parse({ tabs: ["Mẫu 2026", "Sheet1"] }).tabs).toEqual([
      "Mẫu 2026",
      "Sheet1",
    ]);
  });
});

describe("driveItemLabel", () => {
  it("never returns an empty label", () => {
    expect(driveItemLabel({ id: "1", name: "   " })).toBe("(không có tên)");
    expect(driveItemLabel({ id: "1", name: "" })).toBe("(không có tên)");
  });

  it("trims a real name", () => {
    expect(driveItemLabel({ id: "1", name: "  Ảnh sản phẩm " })).toBe("Ảnh sản phẩm");
  });
});

describe("currentFolder", () => {
  it("falls back to the Drive root when the breadcrumb is empty", () => {
    expect(currentFolder([])).toEqual({ id: GOOGLE_DRIVE_ROOT_ID, name: GOOGLE_DRIVE_ROOT_NAME });
  });

  it("takes the last crumb as the folder on screen", () => {
    expect(
      currentFolder([
        { id: "root", name: "Drive của tôi" },
        { id: "1abc", name: "Ảnh sản phẩm" },
      ]),
    ).toEqual({ id: "1abc", name: "Ảnh sản phẩm" });
  });
});

describe("formatConnectedAt", () => {
  it("returns null for an unparseable date instead of NaN on screen", () => {
    expect(formatConnectedAt("hôm qua")).toBeNull();
    expect(formatConnectedAt("")).toBeNull();
  });

  it("formats a real ISO timestamp", () => {
    expect(formatConnectedAt("2026-08-19T03:00:00.000Z")).not.toBeNull();
  });
});
