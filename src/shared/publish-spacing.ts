import { z } from "zod";

/**
 * THE bounds of the publish spacing gap, in one file, for every layer (docs/07
 * §2: `shared/` is pure — no I/O, no layer imports, so `ui/`, `core/` and
 * `app/` may all read it).
 *
 * It lives here rather than only in `core/domain` for the same concrete reason
 * as the password policy: the bulk-run FORM has to say "tối đa 24 giờ" and show
 * the "nên để tối thiểu 5 phút" hint BEFORE the request leaves the browser, and
 * `ui/**` may not import `@/core/*`. A second copy of the numbers in a form
 * schema is a second thing to forget when they change — and a client that
 * accepts what the server refuses is the worst version of that bug.
 *
 * The server still validates (route schema + usecase + a CHECK constraint):
 * this module is shared, not trusted-on-the-client.
 *
 * UNIT IS MILLISECONDS everywhere. A screen that collects minutes multiplies by
 * `MS_PER_MINUTE` before sending.
 */

export const MS_PER_MINUTE = 60_000;

/** A run may switch spacing OFF (0 = post as fast as the queue allows). */
export const MIN_SPACING_MS = 0;
/** One day — the same ceiling the tenant-level setting has always used. */
export const MAX_SPACING_MS = 24 * 60 * MS_PER_MINUTE;
/**
 * What the UI SUGGESTS ("nên để tối thiểu 5 phút"), never what it enforces.
 * The decision is a free-form number of minutes with advice, not a floor: no
 * layer refuses a smaller gap, so a form may warn but must not block.
 */
export const RECOMMENDED_MIN_SPACING_MS = 5 * MS_PER_MINUTE;

/** One wording per refusal, so the form and the 400 response say the same thing. */
export const SPACING_MS_MESSAGES = {
  notANumber: "Khoảng giãn cách phải là một con số (mili-giây).",
  notAnInteger: "Khoảng giãn cách phải là số nguyên mili-giây.",
  belowMin: "Khoảng giãn cách không được là số âm — để 0 nếu muốn đăng liên tục.",
  aboveMax: `Khoảng giãn cách tối đa là ${MAX_SPACING_MS / MS_PER_MINUTE} phút (24 giờ).`,
} as const;

/**
 * The spacing field as it travels over HTTP: milliseconds, optional, nullable.
 *
 * Deliberately NOT `z.coerce`: a string body value is refused rather than read
 * as milliseconds, because "5" means five MINUTES to whoever typed it and five
 * milliseconds here. Absent and null both mean "this run picks nothing, use the
 * tenant setting".
 */
export const spacingMsField = () =>
  z
    .number({ error: SPACING_MS_MESSAGES.notANumber })
    .int(SPACING_MS_MESSAGES.notAnInteger)
    .min(MIN_SPACING_MS, SPACING_MS_MESSAGES.belowMin)
    .max(MAX_SPACING_MS, SPACING_MS_MESSAGES.aboveMax)
    .nullable()
    .optional();

/** Minutes an operator typed -> the milliseconds the API takes. */
export function spacingMinutesToMs(minutes: number): number {
  return Math.round(minutes * MS_PER_MINUTE);
}
