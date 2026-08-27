import { describe, expect, it } from "vitest";

import {
  accountLockedError,
  formatUnlockTime,
  invalidCredentialsError,
  isLocked,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  nextLockoutState,
  weakPasswordError,
} from "../password-credential";

const NOW = new Date(Date.UTC(2026, 7, 24, 9, 0, 0));

// --- Refusals / edge cases first ----------------------------------------------

describe("nextLockoutState — hostile counters", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a negative number", -4],
    ["NaN", Number.NaN],
    ["a string", "3"],
  ])("reads %s as zero rather than refusing to count", (_label, stored) => {
    // Corruption must not turn into an OPEN door: a row nobody can compute a
    // next state for is a row nobody can ever lock.
    expect(nextLockoutState(stored, NOW)).toEqual({ failedAttempts: 1, lockedUntil: null });
  });

  it("floors a fractional counter instead of drifting", () => {
    expect(nextLockoutState(2.7, NOW).failedAttempts).toBe(3);
  });

  it("keeps counting past the limit (a locked row can still be hammered)", () => {
    const beyond = nextLockoutState(MAX_FAILED_ATTEMPTS + 3, NOW);
    expect(beyond.failedAttempts).toBe(MAX_FAILED_ATTEMPTS + 4);
    expect(beyond.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
  });
});

describe("nextLockoutState — the trip point", () => {
  it("does not lock below the limit", () => {
    for (let attempts = 0; attempts < MAX_FAILED_ATTEMPTS - 1; attempts += 1) {
      expect(nextLockoutState(attempts, NOW).lockedUntil).toBeNull();
    }
  });

  it(`locks exactly on failure ${MAX_FAILED_ATTEMPTS}, for ${LOCKOUT_MS / 60000} minutes`, () => {
    const tripped = nextLockoutState(MAX_FAILED_ATTEMPTS - 1, NOW);
    expect(tripped.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(tripped.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
  });
});

describe("isLocked", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an invalid date", new Date("nope")],
  ])("reads %s as NOT locked", (_label, value) => {
    expect(isLocked(value as Date | null, NOW)).toBe(false);
  });

  it("is false the instant the lock expires (no off-by-one lockout)", () => {
    expect(isLocked(new Date(NOW.getTime()), NOW)).toBe(false);
    expect(isLocked(new Date(NOW.getTime() + 1), NOW)).toBe(true);
  });
});

describe("formatUnlockTime", () => {
  it("speaks Vietnamese in Vietnamese time, not in the server's zone", () => {
    // 09:00 UTC is 16:00 in Asia/Ho_Chi_Minh. A UTC hour in an error message is
    // an invitation to come back at the wrong time.
    expect(formatUnlockTime(NOW)).toBe("16:00 ngày 24/08/2026");
  });
});

// --- The typed refusals -------------------------------------------------------

describe("the refusals", () => {
  it("keeps the real reason in the LOG context and out of the message", () => {
    const error = invalidCredentialsError("ACCOUNT_SUSPENDED", { account_id: "acc-1" });
    expect(error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(error.context).toMatchObject({ reason: "ACCOUNT_SUSPENDED", account_id: "acc-1" });
    // The person outside learns nothing about which of the four it was.
    expect(error.userMessage).toBe("Email hoặc mật khẩu không đúng.");
    expect(error.userMessage).not.toContain("suspend");
  });

  it("puts the unlock time in the locked message", () => {
    const error = accountLockedError(new Date(NOW.getTime() + LOCKOUT_MS));
    expect(error.code).toBe("AUTH_ACCOUNT_LOCKED");
    expect(error.userMessage).toContain("16:15 ngày 24/08/2026");
  });

  it("returns null for a password that satisfies the policy", () => {
    expect(weakPasswordError("Str0ng!pass")).toBeNull();
  });

  it("never puts the password itself into the error context", () => {
    const error = weakPasswordError("sup3rsecret");
    expect(error?.code).toBe("AUTH_WEAK_PASSWORD");
    expect(JSON.stringify(error?.context)).not.toContain("sup3rsecret");
    expect(error?.context.problems).toEqual(["uppercase", "symbol"]);
  });
});
