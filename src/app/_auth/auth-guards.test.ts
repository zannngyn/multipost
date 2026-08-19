import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isAllowedEmail,
  isAllowedFacebookUser,
  isBootstrapAdminEmail,
  passesDomainFilter,
} from "./auth.config";
import { isDevFakeSessionEnabled } from "./dev-session";
import { DEFAULT_RETURN_URL, safeReturnUrl } from "./return-url";

/**
 * These three functions are the whole security surface of E1 auth:
 * who may sign in, where they may be redirected, and when the dev bypass opens.
 * Edge cases first — the happy path is the last block on purpose.
 */

const ALLOWED = ["mysp.vn", "example.com"];

describe("isAllowedEmail — edge cases", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { email: "a@mysp.vn" }],
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, value) => {
    expect(isAllowedEmail(value, ALLOWED)).toBe(false);
  });

  it("rejects everything when the allow-list is empty — fail closed", () => {
    expect(isAllowedEmail("boss@mysp.vn", [])).toBe(false);
  });

  it("rejects an address without @", () => {
    expect(isAllowedEmail("mysp.vn", ALLOWED)).toBe(false);
  });

  it("rejects a multi-@ address (a@mysp.vn@evil.com)", () => {
    expect(isAllowedEmail("a@mysp.vn@evil.com", ALLOWED)).toBe(false);
  });

  it("rejects an empty local part or empty domain", () => {
    expect(isAllowedEmail("@mysp.vn", ALLOWED)).toBe(false);
    expect(isAllowedEmail("boss@", ALLOWED)).toBe(false);
  });

  it("rejects a look-alike suffix (notmysp.vn)", () => {
    expect(isAllowedEmail("boss@notmysp.vn", ALLOWED)).toBe(false);
  });

  it("rejects a subdomain that was not allow-listed", () => {
    expect(isAllowedEmail("boss@mail.mysp.vn", ALLOWED)).toBe(false);
  });
});

describe("isAllowedEmail — happy path", () => {
  it("accepts an allow-listed domain", () => {
    expect(isAllowedEmail("boss@mysp.vn", ALLOWED)).toBe(true);
  });

  it("is case-insensitive and trims surrounding spaces", () => {
    expect(isAllowedEmail("  Boss@MYSP.VN  ", ALLOWED)).toBe(true);
  });
});

describe("isAllowedFacebookUser — edge cases", () => {
  const ALLOWED_IDS = ["1234567890", "9876543210"];

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1234567890],
    ["an object", { id: "1234567890" }],
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, value) => {
    expect(isAllowedFacebookUser(value, ALLOWED_IDS)).toBe(false);
  });

  it("rejects everyone when the list is absent — a missing allow-list is not an open door", () => {
    expect(isAllowedFacebookUser("1234567890", undefined)).toBe(false);
  });

  it("rejects everyone when the list is empty — fail closed", () => {
    expect(isAllowedFacebookUser("1234567890", [])).toBe(false);
  });

  it("rejects an id that merely contains an allow-listed one", () => {
    expect(isAllowedFacebookUser("11234567890", ALLOWED_IDS)).toBe(false);
    expect(isAllowedFacebookUser("1234567890123", ALLOWED_IDS)).toBe(false);
  });
});

describe("isAllowedFacebookUser — happy path", () => {
  it("accepts an allow-listed id", () => {
    expect(isAllowedFacebookUser("1234567890", ["1234567890"])).toBe(true);
  });

  it("trims surrounding spaces, matching how the env list is parsed", () => {
    expect(isAllowedFacebookUser("  1234567890  ", ["1234567890"])).toBe(true);
  });
});

describe("safeReturnUrl — open-redirect guard", () => {
  it.each([
    ["absolute http URL", "https://evil.com/x"],
    ["protocol-relative URL", "//evil.com"],
    ["backslash form", "/\\evil.com"],
    ["a bare word", "dashboard"],
    ["empty string", ""],
    ["non-string", 7],
    ["undefined", undefined],
  ])("falls back to / for %s", (_label, value) => {
    expect(safeReturnUrl(value)).toBe(DEFAULT_RETURN_URL);
  });

  it("rejects a value carrying a newline (header injection probe)", () => {
    expect(safeReturnUrl("/ok\nSet-Cookie: a=b")).toBe(DEFAULT_RETURN_URL);
  });

  it("keeps an internal path with its query string", () => {
    expect(safeReturnUrl("/bai-viet?page=2")).toBe("/bai-viet?page=2");
  });
});

describe("isDevFakeSessionEnabled — two independent guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when nothing is set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_FAKE_SESSION", undefined);
    expect(isDevFakeSessionEnabled()).toBe(false);
  });

  it("stays off in production even with the flag set to 1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_FAKE_SESSION", "1");
    expect(isDevFakeSessionEnabled()).toBe(false);
  });

  it("stays off in test even with the flag set to 1", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEV_FAKE_SESSION", "1");
    expect(isDevFakeSessionEnabled()).toBe(false);
  });

  it.each(["true", "yes", "0", " 1", "TRUE"])(
    "requires the exact string \"1\" — %s does not open it",
    (value) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("DEV_FAKE_SESSION", value);
      expect(isDevFakeSessionEnabled()).toBe(false);
    },
  );

  it("opens only when development AND DEV_FAKE_SESSION=1", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_FAKE_SESSION", "1");
    expect(isDevFakeSessionEnabled()).toBe(true);
  });
});

/**
 * The B1 split, at the level of the two pure helpers: a DOMAIN filters, an
 * exact ADDRESS grants. Mixing the two made every colleague an unblockable
 * admin, so both halves are pinned down here.
 */
describe("passesDomainFilter — a filter, never a grant", () => {
  it("passes everything when the list is empty or absent — the registry decides", () => {
    expect(passesDomainFilter("anyone@gmail.com", [])).toBe(true);
    expect(passesDomainFilter("anyone@gmail.com", undefined)).toBe(true);
  });

  it("passes an address inside a listed domain", () => {
    expect(passesDomainFilter("boss@mysp.vn", ALLOWED)).toBe(true);
  });

  it("blocks an address outside every listed domain", () => {
    expect(passesDomainFilter("boss@elsewhere.com", ALLOWED)).toBe(false);
  });

  it("blocks a non-string", () => {
    expect(passesDomainFilter(undefined, ALLOWED)).toBe(false);
  });
});

describe("isBootstrapAdminEmail — exact addresses only", () => {
  const ADMINS = ["boss@mysp.vn", "owner@example.com"];

  it("matches an exact address, case- and space-insensitively", () => {
    expect(isBootstrapAdminEmail("  Boss@MYSP.VN ", ADMINS)).toBe(true);
  });

  it("does NOT match another address in the same domain", () => {
    expect(isBootstrapAdminEmail("colleague@mysp.vn", ADMINS)).toBe(false);
  });

  it("does not treat a bare domain as a member", () => {
    expect(isBootstrapAdminEmail("mysp.vn", ADMINS)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(isBootstrapAdminEmail(value, ADMINS)).toBe(false);
  });

  it("rejects everyone when the list is empty or absent — fail closed", () => {
    expect(isBootstrapAdminEmail("boss@mysp.vn", [])).toBe(false);
    expect(isBootstrapAdminEmail("boss@mysp.vn", undefined)).toBe(false);
  });
});
