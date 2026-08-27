import { describe, expect, it } from "vitest";

import {
  facebookIdFromSessionEmail,
  facebookSessionEmail,
  normaliseDisplayName,
  normaliseEmail,
  normaliseProviderAccountId,
  operatorSessionEmail,
} from "../operator-access";

/**
 * The identity rules the whole access feature stands on. If two identities can
 * collide here, everything downstream files two people under one row.
 */

// --- Edge cases first -------------------------------------------------------

describe("normaliseEmail — refusals", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["empty", ""],
    ["whitespace", "   "],
    ["no @", "mysp.vn"],
    ["two @", "a@b@c.com"],
    ["a space inside", "a b@mysp.vn"],
  ])("rejects %s", (_label, value) => {
    expect(normaliseEmail(value)).toBeNull();
  });

  it("accepts a dot-less domain — dev@localhost is a real actor to attribute", () => {
    expect(normaliseEmail("Dev@localhost")).toBe("dev@localhost");
  });

  it("trims and lower-cases", () => {
    expect(normaliseEmail("  Boss@MYSP.VN ")).toBe("boss@mysp.vn");
  });
});

describe("normaliseProviderAccountId — refusals", () => {
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "  "],
    ["an @ (would forge an address)", "992710700450296@evil"],
    ["a space", "9927 1070"],
    ["a newline (header injection probe)", "992710\n700450296"],
  ])("rejects %s", (_label, value) => {
    expect(normaliseProviderAccountId(value)).toBeNull();
  });

  it("keeps a Facebook app-scoped id as-is", () => {
    expect(normaliseProviderAccountId(" 992710700450296 ")).toBe("992710700450296");
  });
});

describe("normaliseDisplayName", () => {
  it("turns an empty or whitespace-only name into null, not an empty string", () => {
    expect(normaliseDisplayName("")).toBeNull();
    expect(normaliseDisplayName("   ")).toBeNull();
    expect(normaliseDisplayName(undefined)).toBeNull();
  });

  it("strips control characters that would break a log line", () => {
    expect(normaliseDisplayName("Nguyen\nVan A")).toBe("Nguyen Van A");
  });

  it("caps a very long name", () => {
    expect(normaliseDisplayName("x".repeat(500))).toHaveLength(200);
  });
});

// --- Identity keys ----------------------------------------------------------

describe("operatorSessionEmail", () => {
  it("uses the synthetic address for Facebook even when a profile e-mail exists", () => {
    expect(
      operatorSessionEmail({
        provider: "facebook",
        providerAccountId: "992710700450296",
        email: "a@gmail.com",
      }),
    ).toBe("fb-992710700450296@facebook.local");
  });

  it("keeps a Facebook identity distinct from a Google one with the same id", () => {
    const facebook = operatorSessionEmail({ provider: "facebook", providerAccountId: "12345" });
    const google = operatorSessionEmail({
      provider: "google",
      providerAccountId: "12345",
      email: "a@gmail.com",
    });
    expect(facebook).not.toBe(google);
  });

  it("answers null for Google without a usable e-mail — there is no identity key", () => {
    expect(operatorSessionEmail({ provider: "google", providerAccountId: "12345" })).toBeNull();
  });

  it("answers null for an unsupported provider", () => {
    expect(
      operatorSessionEmail({ provider: "github", providerAccountId: "1", email: "a@b.co" }),
    ).toBeNull();
  });

  it("answers null for a Facebook id we refuse to embed", () => {
    expect(operatorSessionEmail({ provider: "facebook", providerAccountId: "a@b" })).toBeNull();
    expect(facebookSessionEmail("")).toBeNull();
  });
});

describe("facebookIdFromSessionEmail — the bootstrap allow-list check", () => {
  it("round-trips the provider id", () => {
    const email = facebookSessionEmail("992710700450296");
    expect(facebookIdFromSessionEmail(email)).toBe("992710700450296");
  });

  it("ignores a real address", () => {
    expect(facebookIdFromSessionEmail("boss@mysp.vn")).toBeNull();
  });

  it("ignores a look-alike domain", () => {
    expect(facebookIdFromSessionEmail("fb-123@facebook.local.evil.com")).toBeNull();
  });
});
