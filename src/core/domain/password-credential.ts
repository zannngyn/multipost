import {
  describePasswordProblems,
  passwordProblems,
  type PasswordRequirement,
} from "@/shared/password-policy";

import { AppError } from "./errors";

/**
 * The pure half of e-mail + password sign-in: the lock-out rule and the four
 * refusals, as data and pure functions. No repo, no hasher, no clock — the
 * usecase supplies "now" and persists what it is told (docs/07 §3.1).
 *
 * WHY A LOCK-OUT AT ALL, given the rate limiter: the limiter is per IP and per
 * address inside a 15-minute window and lives in Redis (or in memory, per
 * process). The lock-out is per CREDENTIAL and lives in Postgres, so it survives
 * a restart, a second web process and an attacker who rotates IPs. They cover
 * different failures; neither replaces the other.
 */

/** Consecutive failures that trip the lock. The 5th wrong password locks. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long a tripped lock holds. Long enough to be useless to a script. */
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LockoutState {
  readonly failedAttempts: number;
  /** Null while under the limit — the column is cleared, not left stale. */
  readonly lockedUntil: Date | null;
}

/**
 * What the credential row must look like AFTER one more wrong password.
 *
 * Pure and total: a stored counter that is negative, fractional, absent or
 * corrupt reads as 0 rather than throwing. A row nobody can compute a next
 * state for is a row nobody can ever lock — refusing here would turn corruption
 * into an OPEN door, which is the wrong direction to fail.
 */
export function nextLockoutState(currentAttempts: unknown, now: Date): LockoutState {
  const previous =
    typeof currentAttempts === "number" && Number.isFinite(currentAttempts) && currentAttempts > 0
      ? Math.floor(currentAttempts)
      : 0;
  const failedAttempts = previous + 1;

  if (failedAttempts < MAX_FAILED_ATTEMPTS) return { failedAttempts, lockedUntil: null };
  return { failedAttempts, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) };
}

/** Is the lock still holding at `now`? A null/invalid date is NOT a lock. */
export function isLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  if (!(lockedUntil instanceof Date)) return false;
  const until = lockedUntil.getTime();
  if (!Number.isFinite(until)) return false;
  return until > now.getTime();
}

/**
 * "14:35 ngày 24/08/2026" — for the Vietnamese message that tells someone when
 * they may try again. Pinned to Asia/Ho_Chi_Minh, not to the server's zone: the
 * operators are all in one country and a UTC timestamp in an error message is
 * an invitation to try again at the wrong hour.
 */
export function formatUnlockTime(lockedUntil: Date): string {
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  }).formatToParts(lockedUntil);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ngày ${get("day")}/${get("month")}/${get("year")}`;
}

/**
 * ONE refusal for every sign-in failure (unknown address, wrong password,
 * suspended account, malformed input). The caller passes the real reason as
 * CONTEXT so the log can answer "vì sao không đăng nhập được" (technical
 * standard #6) while the person outside sees one sentence.
 */
export function invalidCredentialsError(
  reason: string,
  context: Readonly<Record<string, unknown>> = {},
): AppError {
  return new AppError("AUTH_INVALID_CREDENTIALS", {
    message: `Password sign-in refused: ${reason}`,
    context: { ...context, reason },
  });
}

/** Refusal that DOES say more, because the unlock time is the useful part. */
export function accountLockedError(
  lockedUntil: Date,
  context: Readonly<Record<string, unknown>> = {},
): AppError {
  return new AppError("AUTH_ACCOUNT_LOCKED", {
    message: "Credential is locked after consecutive failed attempts",
    userMessage: `Tài khoản đang tạm khoá do nhập sai mật khẩu nhiều lần. Hãy thử lại sau ${formatUnlockTime(
      lockedUntil,
    )}.`,
    context: { ...context, locked_until: lockedUntil.toISOString() },
  });
}

/**
 * Turns the shared policy's problem list into the typed refusal, with the
 * missing rules spelled out in Vietnamese (task rule 2). Returns null when the
 * password is fine, so callers stay a guard clause rather than a try/catch.
 */
export function weakPasswordError(
  password: unknown,
  context: Readonly<Record<string, unknown>> = {},
): AppError | null {
  const problems: readonly PasswordRequirement[] = passwordProblems(password);
  if (problems.length === 0) return null;

  return new AppError("AUTH_WEAK_PASSWORD", {
    message: `Password policy not satisfied: ${problems.join(", ")}`,
    userMessage: describePasswordProblems(problems),
    // The password itself NEVER appears here — only which rules it broke.
    context: { ...context, problems },
  });
}
