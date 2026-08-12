import { afterEach, describe, expect, it, vi } from "vitest";

import { isAllowedEmail } from "./auth.config";
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
