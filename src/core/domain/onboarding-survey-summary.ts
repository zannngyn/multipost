import { AppError } from "./errors";

/**
 * Aggregation of the onboarding survey across every tenant (E10 — plan task
 * 11). Pure: no I/O, no clock, no tenant scope. The caller hands in the rows it
 * already read; this only counts them.
 *
 * THE RULE THIS FILE EXISTS FOR — get it wrong and every number below is wrong:
 *   null  = "no answer" (the operator pressed Bỏ qua, or never reached the
 *           step, or the tenant has no tenant_profile row at all);
 *   []    = "answered: none of these" — an ANSWER, a different fact;
 *   value = an answer.
 * They are counted in SEPARATE buckets (`noAnswer` vs `answeredNone`) and are
 * never summed here. "Bao nhiêu người bỏ qua bước này" is the most valuable
 * number this aggregation produces, and merging the two destroys it.
 *
 * The fourth bucket, `unreadable`, exists for the same reason: a blank string
 * or a scalar in a `text[]` column is corrupt data, not a skip. Filing it under
 * `noAnswer` would quietly inflate the skip rate; dropping it would make the
 * buckets stop adding up to the row count. It is counted, and every breakdown
 * satisfies `noAnswer + answered + (answeredNone) + unreadable === total`.
 *
 * OUT OF SCOPE by decision, not by omission: per-step drop-off, cohorts over
 * time, conversion funnels. Only the FINAL answers are stored — nothing records
 * who skipped which step and when — so any such number would be invented here.
 */

/**
 * The shape read out of a tenant_profile row. Fields are `unknown` on purpose:
 * this counts data that came out of a database with no enum and no check
 * constraint, so every read is guarded rather than trusted. An
 * `OnboardingProfile` satisfies it structurally.
 */
export interface SurveyAnswers {
  readonly sellerKind?: unknown;
  readonly currentTools?: unknown;
  readonly channelCount?: unknown;
  readonly focusChannels?: unknown;
  readonly completedAt?: unknown;
}

export interface SurveyCodeTally {
  readonly code: string;
  readonly count: number;
}

/** One-choice question (step 1). */
export interface SingleAnswerBreakdown {
  /** Tenants considered — always the full list, never only those who answered. */
  readonly total: number;
  /** Tenants whose stored value is a readable code. */
  readonly answered: number;
  /** Tenants with `null`: skipped, not reached, or no profile row at all. */
  readonly noAnswer: number;
  /** Tenants whose stored value is neither null nor a readable code. */
  readonly unreadable: number;
  /** Ranked; see `rank()` for the ordering. */
  readonly byCode: readonly SurveyCodeTally[];
}

/** Many-choice question (steps 2 and 4). */
export interface MultiAnswerBreakdown {
  readonly total: number;
  /** Tenants whose stored value is a non-empty list. */
  readonly answered: number;
  /** Tenants who answered `[]` — "none of these". NOT the same as `noAnswer`. */
  readonly answeredNone: number;
  /** Tenants with `null`. NOT the same as `answeredNone`. */
  readonly noAnswer: number;
  /** Tenants whose stored value is present but is not a list. */
  readonly unreadable: number;
  /** Entries inside a list that are not readable codes. Not votes. */
  readonly unreadableVotes: number;
  /** Sum of `byCode` — one tenant may contribute several. */
  readonly votes: number;
  readonly byCode: readonly SurveyCodeTally[];
}

export interface OnboardingSurveySummary {
  /** Every tenant handed in, answered or not. The denominator. */
  readonly total: number;
  /** Tenants with a `completed_at`. */
  readonly completed: number;
  readonly notCompleted: number;
  readonly sellerKind: SingleAnswerBreakdown;
  readonly channelCount: SingleAnswerBreakdown;
  readonly currentTools: MultiAnswerBreakdown;
  readonly focusChannels: MultiAnswerBreakdown;
}

/**
 * Codes the product currently offers. Optional, and only ever ADDITIVE: a code
 * listed here but chosen by nobody appears with `count: 0` instead of vanishing
 * — "nên làm TikTok hay Instagram trước" cannot be answered when the channel
 * with zero votes is simply missing from the list. A code found in the data but
 * absent here is still counted: dropping a retired code would under-count and
 * make the ranking disagree with the rows underneath.
 */
export interface SurveyVocabulary {
  readonly sellerKind?: readonly string[];
  readonly channelCount?: readonly string[];
  readonly currentTools?: readonly string[];
  readonly focusChannels?: readonly string[];
}

type Row = SurveyAnswers | null | undefined;

/** A stored value we can count as a code. Trimmed; blanks are not codes. */
function readCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Count desc, then code asc. The tie-break is not cosmetic: without it the
 * order of two equally popular channels would follow insertion order, so the
 * same data would render differently on two page loads and nobody could tell
 * whether the ranking had moved.
 */
function rank(counts: ReadonlyMap<string, number>): readonly SurveyCodeTally[] {
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Zero-seeded so an offered-but-unchosen option is a visible 0. */
function seed(known: readonly string[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(known)) return counts;
  for (const code of known) {
    const readable = readCode(code);
    if (readable !== null) counts.set(readable, 0);
  }
  return counts;
}

function bump(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function summarizeSingle(
  rows: readonly Row[],
  field: "sellerKind" | "channelCount",
  known: readonly string[] | undefined,
): SingleAnswerBreakdown {
  const counts = seed(known);
  let answered = 0;
  let noAnswer = 0;
  let unreadable = 0;

  for (const row of rows) {
    // No profile row = never started the survey. Still a tenant, still counted.
    const value = row == null ? null : row[field];
    if (value === null || value === undefined) {
      noAnswer += 1;
      continue;
    }
    const code = readCode(value);
    if (code === null) {
      unreadable += 1;
      continue;
    }
    answered += 1;
    bump(counts, code);
  }

  return { total: rows.length, answered, noAnswer, unreadable, byCode: rank(counts) };
}

function summarizeMulti(
  rows: readonly Row[],
  field: "currentTools" | "focusChannels",
  known: readonly string[] | undefined,
): MultiAnswerBreakdown {
  const counts = seed(known);
  let answered = 0;
  let answeredNone = 0;
  let noAnswer = 0;
  let unreadable = 0;
  let unreadableVotes = 0;
  let votes = 0;

  for (const row of rows) {
    const value = row == null ? null : row[field];
    if (value === null || value === undefined) {
      noAnswer += 1;
      continue;
    }
    // A scalar in a list column is corrupt, and must not read as "none of
    // these" — that would be the null/[] confusion arriving by another door.
    if (!Array.isArray(value)) {
      unreadable += 1;
      continue;
    }
    if (value.length === 0) {
      answeredNone += 1;
      continue;
    }

    answered += 1;
    // One tenant is one vote per code: a duplicate in the stored array (two
    // tabs, a retry) must not double the demand signal for a channel.
    const seen = new Set<string>();
    for (const entry of value) {
      const code = readCode(entry);
      if (code === null) {
        unreadableVotes += 1;
        continue;
      }
      if (seen.has(code)) continue;
      seen.add(code);
      votes += 1;
      bump(counts, code);
    }
  }

  return {
    total: rows.length,
    answered,
    answeredNone,
    noAnswer,
    unreadable,
    unreadableVotes,
    votes,
    byCode: rank(counts),
  };
}

/** A Date that survived a JSON round trip is a string; both are accepted. */
function isCompleted(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return readCode(value) !== null;
}

export function summarizeOnboardingSurvey(
  rows: readonly Row[],
  known: SurveyVocabulary = {},
): OnboardingSurveySummary {
  // --- Edge case first: a caller bug must not forge "no tenants yet" --------
  if (!Array.isArray(rows)) {
    throw new AppError("INVALID_INPUT", {
      message: "summarizeOnboardingSurvey requires an array of profile rows",
      userMessage: "Không đọc được số liệu khảo sát.",
      context: { operation: "summarizeOnboardingSurvey", received: typeof rows },
    });
  }

  const vocabulary = typeof known === "object" && known !== null ? known : {};

  let completed = 0;
  for (const row of rows) {
    if (row != null && isCompleted(row.completedAt)) completed += 1;
  }

  return {
    total: rows.length,
    completed,
    notCompleted: rows.length - completed,
    sellerKind: summarizeSingle(rows, "sellerKind", vocabulary.sellerKind),
    channelCount: summarizeSingle(rows, "channelCount", vocabulary.channelCount),
    currentTools: summarizeMulti(rows, "currentTools", vocabulary.currentTools),
    focusChannels: summarizeMulti(rows, "focusChannels", vocabulary.focusChannels),
  };
}
