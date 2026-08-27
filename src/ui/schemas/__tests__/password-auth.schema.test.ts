import { describe, expect, it } from "vitest";

import {
  AUTH_MODE_LABELS,
  authFailureHint,
  authModeHref,
  confirmPasswordProblem,
  emailShapeProblem,
  fieldErrorMessage,
  formErrorMessage,
  newPasswordProblem,
  parseAuthMode,
  passwordHint,
  resetPasswordBlockReason,
  type PasswordAuthFailure,
} from "@/ui/schemas/password-auth.schema";
import { describePasswordProblems, passwordProblems } from "@/shared/password-policy";

/**
 * The decisions the sign-in screen makes BEFORE anything is rendered: which box
 * a refusal lands in, what the password hint says, and which tab is open.
 *
 * These are unit tests over pure functions rather than render tests: the repo
 * has no @testing-library/react and no jsdom environment (vitest.config.ts runs
 * `environment: "node"`), and adding either is a dependency decision that is not
 * this task's to make. Everything a render test would assert about the three
 * behaviours below is decided here.
 */

function failure(patch: Partial<PasswordAuthFailure>): PasswordAuthFailure {
  return {
    ok: false,
    code: "AUTH_INVALID_CREDENTIALS",
    message: "Email hoặc mật khẩu không đúng.",
    field: "password",
    ...patch,
  };
}

describe("fieldErrorMessage / formErrorMessage — a refusal shows in exactly one place", () => {
  // --- Edge cases first -----------------------------------------------------
  it("says nothing at all while the form is idle", () => {
    expect(fieldErrorMessage(null, "email")).toBeNull();
    expect(fieldErrorMessage(null, "password")).toBeNull();
    expect(formErrorMessage(null)).toBeNull();
    expect(authFailureHint(null)).toBeNull();
  });

  it("keeps a field refusal OUT of the banner", () => {
    const state = failure({ field: "email", message: "Email này đã được đăng ký." });
    expect(fieldErrorMessage(state, "email")).toBe("Email này đã được đăng ký.");
    expect(fieldErrorMessage(state, "password")).toBeNull();
    expect(formErrorMessage(state)).toBeNull();
  });

  it("keeps a form-level refusal OUT of both fields", () => {
    const state = failure({ field: null, code: "AUTH_RATE_LIMITED", message: "Chờ 2 phút." });
    expect(formErrorMessage(state)).toBe("Chờ 2 phút.");
    expect(fieldErrorMessage(state, "email")).toBeNull();
    expect(fieldErrorMessage(state, "password")).toBeNull();
  });

  it("pins a weak-password refusal to the password box", () => {
    const state = failure({
      code: "AUTH_WEAK_PASSWORD",
      field: "password",
      message: "Mật khẩu phải có ít nhất 1 chữ số (0–9).",
      problems: ["digit"],
    });
    expect(fieldErrorMessage(state, "password")).toContain("chữ số");
    expect(formErrorMessage(state)).toBeNull();
  });
});

describe("authFailureHint — every blocked state has a way out", () => {
  it("names the human who can unlock a locked account", () => {
    const hint = authFailureHint(failure({ code: "AUTH_ACCOUNT_LOCKED", field: null }));
    expect(hint).toContain("quản trị viên hệ thống");
  });

  it("tells a rate-limited person that retrying makes it worse", () => {
    expect(authFailureHint(failure({ code: "AUTH_RATE_LIMITED", field: null }))).toContain("đợi");
  });

  it("sends a taken address to the sign-in tab", () => {
    expect(authFailureHint(failure({ code: "AUTH_EMAIL_TAKEN", field: "email" }))).toContain(
      "Đăng nhập",
    );
  });

  it("stays silent for a code it has nothing extra to say about", () => {
    expect(authFailureHint(failure({ code: "INVALID_INPUT", field: "email" }))).toBeNull();
    expect(authFailureHint(failure({ code: "INTERNAL", field: null }))).toBeNull();
  });
});

describe("passwordHint — everything missing, in ONE sentence", () => {
  // --- Edge cases first -----------------------------------------------------
  it("names all four rules for an empty box, and never mentions the ceiling", () => {
    const { message, isReady } = passwordHint("");
    expect(isReady).toBe(false);
    expect(message).toContain("ít nhất 8 ký tự");
    expect(message).toContain("chữ in hoa");
    expect(message).toContain("chữ số");
    expect(message).toContain("ký tự đặc biệt");
    expect(message).not.toContain("tối đa");
  });

  it("is ONE sentence — one full stop, however many rules are broken", () => {
    expect(passwordHint("").message.match(/\./g)).toHaveLength(1);
    expect(passwordHint("abcdefgh").message.match(/\./g)).toHaveLength(1);
  });

  it("drops a rule from the sentence as soon as the value satisfies it", () => {
    const message = passwordHint("abcdefgh").message;
    expect(message).not.toContain("ít nhất 8 ký tự");
    expect(message).toContain("chữ in hoa");
    expect(message).toContain("chữ số");
    expect(message).toContain("ký tự đặc biệt");
  });

  it("says so, once, for a password that passes the policy", () => {
    expect(passwordHint("Mysp2026!")).toEqual({
      message: "Mật khẩu đã đạt đủ yêu cầu.",
      isReady: true,
    });
  });

  it("counts a space as neither a symbol nor a reason to fail the others", () => {
    const message = passwordHint("Mat khau 1").message;
    expect(message).toContain("ký tự đặc biệt");
    expect(message).not.toContain("chữ số");
    expect(message).not.toContain("chữ in hoa");
  });

  it("names the ceiling ONLY once it is broken", () => {
    const { message, isReady } = passwordHint(`A1!${"a".repeat(200)}`);
    expect(isReady).toBe(false);
    expect(message).toContain("tối đa 128 ký tự");
  });

  it("carries the wording of the shared policy, not its own copy", () => {
    expect(passwordHint("")).toEqual({
      message: describePasswordProblems(passwordProblems("")),
      isReady: false,
    });
  });
});

describe("confirmPasswordProblem / newPasswordProblem", () => {
  it("stays silent while the confirmation box is untouched", () => {
    expect(confirmPasswordProblem("Mysp2026!", "")).toBeNull();
  });

  it("reports a mismatch, and only a mismatch", () => {
    expect(confirmPasswordProblem("Mysp2026!", "Mysp2026")).toBe("Hai ô mật khẩu chưa khớp.");
    expect(confirmPasswordProblem("Mysp2026!", "Mysp2026!")).toBeNull();
  });

  it("refuses an empty, a weak, an unconfirmed and a mismatched new password", () => {
    expect(newPasswordProblem("", "")).toBe("Chưa nhập mật khẩu mới.");
    expect(newPasswordProblem("abcdefgh", "abcdefgh")).toContain("chưa đạt đủ yêu cầu");
    expect(newPasswordProblem("Mysp2026!", "")).toBe("Chưa nhập lại mật khẩu mới.");
    expect(newPasswordProblem("Mysp2026!", "Mysp2025!")).toBe("Hai ô mật khẩu chưa khớp.");
  });

  it("names the ceiling instead of the generic sentence when the value is too long", () => {
    expect(newPasswordProblem(`A1!${"a".repeat(200)}`, `A1!${"a".repeat(200)}`)).toBe(
      "tối đa 128 ký tự",
    );
  });

  it("lets a matching, strong pair through", () => {
    expect(newPasswordProblem("Mysp2026!", "Mysp2026!")).toBeNull();
  });
});

describe("parseAuthMode / authModeHref — switching tabs", () => {
  // --- Edge cases first -----------------------------------------------------
  it("falls back to the sign-in tab for anything that is not `register`", () => {
    expect(parseAuthMode(undefined)).toBe("signin");
    expect(parseAuthMode(null)).toBe("signin");
    expect(parseAuthMode("")).toBe("signin");
    expect(parseAuthMode("REGISTER")).toBe("signin");
    expect(parseAuthMode("<script>")).toBe("signin");
    expect(parseAuthMode(42)).toBe("signin");
  });

  it("reads the first value when the param is repeated", () => {
    expect(parseAuthMode(["register", "signin"])).toBe("register");
    expect(parseAuthMode([])).toBe("signin");
  });

  it("opens the register tab when asked", () => {
    expect(parseAuthMode("register")).toBe("register");
  });

  it("builds a clean address for each tab", () => {
    expect(authModeHref("signin", "/")).toBe("/signin");
    expect(authModeHref("register", "/")).toBe("/signin?mode=register");
  });

  it("carries returnUrl across the switch, encoded", () => {
    expect(authModeHref("register", "/posts?batch=1")).toBe(
      "/signin?mode=register&returnUrl=%2Fposts%3Fbatch%3D1",
    );
    expect(authModeHref("signin", "/members")).toBe("/signin?returnUrl=%2Fmembers");
  });

  it("labels both tabs in Vietnamese", () => {
    expect(AUTH_MODE_LABELS.signin).toBe("Đăng nhập");
    expect(AUTH_MODE_LABELS.register).toBe("Đăng ký");
  });
});

describe("resetPasswordBlockReason — who the admin can reset", () => {
  // --- Edge cases first -----------------------------------------------------
  it("refuses an account with no address, and says why", () => {
    expect(resetPasswordBlockReason({ email: null })).toContain("không có email");
    expect(resetPasswordBlockReason({ email: "" })).toContain("không có email");
    expect(resetPasswordBlockReason({ email: "   " })).toContain("không có email");
  });

  it("allows an account that has one — the server still decides", () => {
    expect(resetPasswordBlockReason({ email: "van@mysp.vn" })).toBeNull();
  });
});

describe("emailShapeProblem — the address is checked with the server's own schema", () => {
  // --- Edge cases first -----------------------------------------------------
  it("refuses an empty or whitespace-only box", () => {
    expect(emailShapeProblem("")).toBe("Chưa nhập email.");
    expect(emailShapeProblem("   ")).toBe("Chưa nhập email.");
  });

  it("refuses anything that is not one address", () => {
    expect(emailShapeProblem("van")).toContain("không hợp lệ");
    expect(emailShapeProblem("van@")).toContain("không hợp lệ");
    expect(emailShapeProblem("@mysp.vn")).toContain("không hợp lệ");
    expect(emailShapeProblem("van@@mysp.vn")).toContain("không hợp lệ");
    expect(emailShapeProblem("van mysp@mysp.vn")).toContain("không hợp lệ");
  });

  it("refuses an address past the RFC ceiling", () => {
    expect(emailShapeProblem(`${"a".repeat(320)}@mysp.vn`)).toContain("tối đa 320");
  });

  it("accepts what the server accepts — no stricter, no looser", () => {
    // The server's schema does not require a dot in the domain, so neither may
    // this: refusing `van@localhost` here would refuse a request the server
    // would have taken.
    expect(emailShapeProblem("van@mysp.vn")).toBeNull();
    expect(emailShapeProblem("  Van@MYSP.vn  ")).toBeNull();
    expect(emailShapeProblem("van@localhost")).toBeNull();
    expect(emailShapeProblem("van+bulk@mysp.vn")).toBeNull();
  });
});
