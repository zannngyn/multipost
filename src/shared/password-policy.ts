import { z } from "zod";

/**
 * THE password rules, in one file, for every layer (docs/07 §2: `shared/` is
 * pure — no I/O, no layer imports, so `ui/`, `core/` and `app/` may all read it).
 *
 * It lives here rather than in `core/domain` for a concrete reason: the sign-up
 * FORM has to say "thiếu chữ in hoa" BEFORE the request leaves the browser, and
 * `ui/**` may not import `@/core/*`. A second copy of the rules in a form schema
 * is a second thing to forget when the policy changes — and a client that
 * accepts what the server refuses is the worst version of that bug.
 *
 * The server still validates: this module is shared, not trusted-on-the-client.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** RFC 5321 practical ceiling; matches `normaliseEmail` in operator-access. */
export const EMAIL_MAX_LENGTH = 320;

/**
 * Which rule a password failed. Codes, not sentences: the Vietnamese wording
 * belongs to one table (below) so a log can carry the code and the screen the
 * sentence, without either inventing its own.
 */
export const PASSWORD_REQUIREMENTS = ["length", "too_long", "uppercase", "digit", "symbol"] as const;
export type PasswordRequirement = (typeof PASSWORD_REQUIREMENTS)[number];

/**
 * Deliberately ASCII A–Z. Unicode case folding would let `Đ` satisfy "chữ in
 * hoa" on one platform and not another (the browser and Node do not agree on
 * every script), and a rule that passes client-side then fails server-side is
 * worse than a slightly strict rule that behaves the same everywhere.
 */
const UPPERCASE_PATTERN = /[A-Z]/;
const DIGIT_PATTERN = /[0-9]/;
/**
 * "Not a letter or a digit" — and not whitespace either. A space is allowed
 * INSIDE a password (pass-phrases are good), it just does not count as the
 * special character, because "  " would otherwise satisfy the rule silently.
 */
const SYMBOL_PATTERN = /[^A-Za-z0-9\s]/;

const REQUIREMENT_MESSAGES_VI: Record<PasswordRequirement, string> = {
  length: `ít nhất ${PASSWORD_MIN_LENGTH} ký tự`,
  too_long: `tối đa ${PASSWORD_MAX_LENGTH} ký tự`,
  uppercase: "1 chữ in hoa (A–Z)",
  digit: "1 chữ số (0–9)",
  symbol: "1 ký tự đặc biệt (không phải chữ hoặc số)",
};

/**
 * Every rule the value breaks, in a stable order — not just the first one.
 * A form that reveals one missing rule per submit makes the person guess four
 * times; the whole list is one screen.
 *
 * Anything that is not a string breaks EVERY rule: `undefined` is not "a short
 * password", it is no password at all, and silently treating it as `""` is the
 * kind of default CLAUDE.md rule 2 forbids.
 */
export function passwordProblems(value: unknown): readonly PasswordRequirement[] {
  if (typeof value !== "string") return PASSWORD_REQUIREMENTS.filter((rule) => rule !== "too_long");

  const problems: PasswordRequirement[] = [];
  if (value.length < PASSWORD_MIN_LENGTH) problems.push("length");
  if (value.length > PASSWORD_MAX_LENGTH) problems.push("too_long");
  if (!UPPERCASE_PATTERN.test(value)) problems.push("uppercase");
  if (!DIGIT_PATTERN.test(value)) problems.push("digit");
  if (!SYMBOL_PATTERN.test(value)) problems.push("symbol");
  return problems;
}

/**
 * ONE Vietnamese sentence listing exactly what is missing. Never empty-handed.
 *
 * One sentence, not a list of them: whatever a password breaks, the person is
 * told once, in a single message — a screen that shows one complaint per rule
 * makes them read four things to learn one ("gộp thành 1 thông báo"). The
 * clauses are joined the way Vietnamese joins them, "a, b và c", so the whole
 * thing still reads as a sentence when four rules are broken at once.
 */
export function describePasswordProblems(problems: readonly PasswordRequirement[]): string {
  if (problems.length === 0) return "Mật khẩu hợp lệ.";
  const parts = problems.map((rule) => REQUIREMENT_MESSAGES_VI[rule]);
  return `Mật khẩu phải có ${joinVi(parts)}.`;
}

/** `["a"] -> "a"`, `["a","b"] -> "a và b"`, `["a","b","c"] -> "a, b và c"`. */
function joinVi(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} và ${parts[parts.length - 1]}`;
}

/** The wording of ONE rule — for a checklist next to the field. */
export function describePasswordRequirement(rule: PasswordRequirement): string {
  return REQUIREMENT_MESSAGES_VI[rule];
}

/**
 * The broken rules carried by a `PasswordSchema` issue, or undefined when the
 * issue came from somewhere else.
 *
 * A helper rather than `issue.params.problems` at each call site: in zod 4 only
 * the `custom` member of the issue union HAS `params`, so every reader would
 * otherwise repeat the same narrowing — and the array inside is `unknown`,
 * which a checklist must not render blindly.
 */
export function problemsFromIssue(issue: {
  code?: string;
  params?: unknown;
}): readonly PasswordRequirement[] | undefined {
  if (issue?.code !== "custom") return undefined;
  const problems = (issue.params as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(problems)) return undefined;
  return problems.filter((value): value is PasswordRequirement =>
    (PASSWORD_REQUIREMENTS as readonly unknown[]).includes(value),
  );
}

/**
 * NOT trimmed on purpose: a trailing space is part of the password the person
 * typed, and trimming it here would make the stored hash disagree with what
 * their password manager replays.
 */
export const PasswordSchema = z.string().superRefine((value, ctx) => {
  const problems = passwordProblems(value);
  if (problems.length === 0) return;
  ctx.addIssue({
    code: "custom",
    message: describePasswordProblems(problems),
    params: { problems },
  });
});

/**
 * The address as an IDENTITY KEY: trimmed and lower-cased, because that is what
 * the unique index on `credential.email` holds. Shape checking stays as loose as
 * `shared/operator-access.normaliseEmail` (one `@`, no spaces, domain need not
 * contain a dot) — validating addresses harder than the sign-in gate does only
 * refuses real people.
 */
export const CredentialEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(EMAIL_MAX_LENGTH)
  .regex(/^[^\s@]+@[^\s@]+$/, "Địa chỉ email không hợp lệ.");

/** Optional human name. Empty/whitespace becomes undefined, never `""`. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

export const RegisterWithPasswordSchema = z.object({
  email: CredentialEmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});

/**
 * Sign-in does NOT re-apply the strength rules: an account created before a
 * policy change must still be able to log in (and then be asked to change it).
 * Only "there is something here" is checked, so an empty submit is refused
 * before any hashing is done.
 */
export const SignInWithPasswordSchema = z.object({
  email: CredentialEmailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type RegisterWithPasswordInput = z.infer<typeof RegisterWithPasswordSchema>;
export type SignInWithPasswordInput = z.infer<typeof SignInWithPasswordSchema>;
