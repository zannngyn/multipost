import { describe, expect, it } from "vitest";

import {
  CredentialEmailSchema,
  describePasswordProblems,
  PASSWORD_MAX_LENGTH,
  PasswordSchema,
  passwordProblems,
  problemsFromIssue,
  RegisterWithPasswordSchema,
  SignInWithPasswordSchema,
} from "../password-policy";

/**
 * The rules the FORM and the SERVER both read. Anything that passes here must
 * pass on both sides — that is the whole reason the module lives in `shared/`.
 */

// --- Refusals first -----------------------------------------------------------

describe("passwordProblems — refusals", () => {
  it.each([
    ["empty", "", ["length", "uppercase", "digit", "symbol"]],
    ["too short but otherwise complete", "Ab1!", ["length"]],
    ["no uppercase", "str0ng!pass", ["uppercase"]],
    ["no digit", "Strong!pass", ["digit"]],
    ["no symbol", "Str0ngpass", ["symbol"]],
    ["only lower letters", "abcdefgh", ["uppercase", "digit", "symbol"]],
  ])("flags %s", (_label, value, expected) => {
    expect(passwordProblems(value)).toEqual(expected);
  });

  it("treats a non-string as breaking every rule, not as an empty password", () => {
    // `undefined` is no password at all; silently reading it as "" is exactly
    // the quiet default CLAUDE.md rule 2 forbids.
    expect(passwordProblems(undefined)).toEqual(["length", "uppercase", "digit", "symbol"]);
    expect(passwordProblems(12345678)).toContain("length");
  });

  it("refuses a password over the length ceiling", () => {
    const long = `A1!${"a".repeat(PASSWORD_MAX_LENGTH)}`;
    expect(passwordProblems(long)).toEqual(["too_long"]);
  });

  it("does not let whitespace pass as the special character", () => {
    expect(passwordProblems("Str0ng pass")).toEqual(["symbol"]);
  });

  it("accepts a space INSIDE an otherwise valid pass-phrase", () => {
    expect(passwordProblems("Con meo tr3o cay!")).toEqual([]);
  });
});

describe("describePasswordProblems", () => {
  it("lists every missing rule in one Vietnamese sentence", () => {
    const message = describePasswordProblems(passwordProblems("abc"));
    expect(message).toContain("ít nhất 8 ký tự");
    expect(message).toContain("chữ in hoa");
    expect(message).toContain("chữ số");
    expect(message).toContain("ký tự đặc biệt");
  });

  it("is ONE sentence — the clauses are joined, never split into several", () => {
    const message = describePasswordProblems(passwordProblems("abc"));
    expect(message.match(/\./g)).toHaveLength(1);
    expect(message).toContain(" và ");
    expect(message).not.toContain(";");
  });

  it("joins two clauses with `và` alone, and one with nothing at all", () => {
    expect(describePasswordProblems(["uppercase", "digit"])).toBe(
      "Mật khẩu phải có 1 chữ in hoa (A–Z) và 1 chữ số (0–9).",
    );
    expect(describePasswordProblems(["digit"])).toBe("Mật khẩu phải có 1 chữ số (0–9).");
  });

  it("says the password is fine when nothing is broken", () => {
    expect(describePasswordProblems([])).toBe("Mật khẩu hợp lệ.");
  });
});

describe("PasswordSchema", () => {
  it("carries the broken rules as issue params so a checklist can tick them", () => {
    const parsed = PasswordSchema.safeParse("abc");
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(problemsFromIssue(parsed.error.issues[0])).toEqual([
      "length",
      "uppercase",
      "digit",
      "symbol",
    ]);
  });

  it("does NOT trim — a trailing space is part of the password", () => {
    const value = "Str0ng!pass ";
    expect(PasswordSchema.parse(value)).toBe(value);
  });
});

describe("problemsFromIssue", () => {
  it("returns undefined for an issue that is not ours", () => {
    const other = CredentialEmailSchema.safeParse("nope");
    expect(other.success).toBe(false);
    if (other.success) return;
    expect(problemsFromIssue(other.error.issues[0])).toBeUndefined();
  });

  it("drops anything in the array that is not a known rule", () => {
    expect(problemsFromIssue({ code: "custom", params: { problems: ["digit", "nonsense"] } })).toEqual([
      "digit",
    ]);
  });
});

describe("CredentialEmailSchema — refusals", () => {
  it.each([["no at sign", "nope"], ["two at signs", "a@b@c"], ["a space", "a b@c.vn"], ["empty", "  "]])(
    "refuses %s",
    (_label, value) => {
      expect(CredentialEmailSchema.safeParse(value).success).toBe(false);
    },
  );

  it("normalises to the identity key the unique index holds", () => {
    expect(CredentialEmailSchema.parse("  Worker@MYSP.VN  ")).toBe("worker@mysp.vn");
  });
});

// --- Happy path ---------------------------------------------------------------

describe("form schemas", () => {
  it("register: normalises the address and drops an empty display name", () => {
    const parsed = RegisterWithPasswordSchema.parse({
      email: " New@MYSP.vn ",
      password: "Str0ng!pass",
      displayName: "   ",
    });
    expect(parsed.email).toBe("new@mysp.vn");
    expect(parsed.displayName).toBeUndefined();
  });

  it("sign-in does not re-apply the strength rules", () => {
    // An account created before a policy change must still be able to log in.
    expect(
      SignInWithPasswordSchema.safeParse({ email: "old@mysp.vn", password: "weak" }).success,
    ).toBe(true);
  });

  it("sign-in still refuses an empty password before anything is hashed", () => {
    expect(
      SignInWithPasswordSchema.safeParse({ email: "old@mysp.vn", password: "" }).success,
    ).toBe(false);
  });
});
