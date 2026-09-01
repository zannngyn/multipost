import {
  MAX_SPACING_MS,
  MIN_SPACING_MS,
  SPACING_MS_MESSAGES,
} from "@/shared/publish-spacing";

/**
 * Spacing between two posts — the pure rules behind the spacing gate (brief §6:
 * "khoảng cách chỉnh được"). No I/O; the only import is `shared/` (docs/07 §2).
 *
 * PENDING(E1): the gap is measured between posts of the SAME CHANNEL. Two
 * channels never wait for each other, because the rate limit that matters is per
 * Page. Nothing here may be widened to "gap between the posts of a run" until E1
 * is decided — that is a different rule, not a bigger number.
 *
 * TWO LEVELS, one winner:
 *   - the RUN (post_batch.spacing_ms) — what an operator picked for this batch;
 *   - the TENANT (PublishSettings.spacingMs) — the standing configuration.
 * A batch with no value of its own behaves exactly as before this feature
 * existed: it reads the tenant's. That is the whole compatibility contract for
 * every batch created before the column was added.
 */

/**
 * The NUMBERS live in `shared/` because `ui/**` may not import `@/core/*` and
 * the bulk-run form has to know them too (same reason as shared/password-policy).
 * Re-exported here so core/adapters keep one import path for the whole rule.
 */
export {
  MIN_SPACING_MS,
  MAX_SPACING_MS,
  RECOMMENDED_MIN_SPACING_MS,
  MS_PER_MINUTE,
} from "@/shared/publish-spacing";

/** Why a submitted spacing value was refused. Machine-readable, for logs/audit. */
export type SpacingRejection = "NOT_A_NUMBER" | "NOT_AN_INTEGER" | "BELOW_MIN" | "ABOVE_MAX";

export type SpacingVerdict =
  /** `ms === null` = "no value for this run", i.e. fall back to the tenant. */
  | { readonly ok: true; readonly ms: number | null }
  | { readonly ok: false; readonly reason: SpacingRejection; readonly received: unknown };

/** True only for a value that may be stored on a batch. */
export function isValidSpacingMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SPACING_MS &&
    value <= MAX_SPACING_MS
  );
}

/**
 * Reads what a caller sent for THIS run.
 *
 * Edge cases first, and every one of them is answered explicitly:
 *   undefined / null  -> ok, no value (the tenant setting keeps applying)
 *   NaN / Infinity    -> refused (a NaN would silently disable the gate)
 *   "5" / true / {}   -> refused; this layer never coerces a string to a number,
 *                       because "5" typed in a form means 5 MINUTES to a human
 *                       and 5 milliseconds here (the HTTP boundary converts)
 *   1.5               -> refused; a fractional millisecond is a caller bug
 *   negative / > 24h  -> refused, naming which bound was crossed
 */
export function parseBatchSpacingMs(raw: unknown): SpacingVerdict {
  if (raw === null || raw === undefined) return { ok: true, ms: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, reason: "NOT_A_NUMBER", received: raw };
  }
  if (!Number.isInteger(raw)) return { ok: false, reason: "NOT_AN_INTEGER", received: raw };
  if (raw < MIN_SPACING_MS) return { ok: false, reason: "BELOW_MIN", received: raw };
  if (raw > MAX_SPACING_MS) return { ok: false, reason: "ABOVE_MAX", received: raw };
  return { ok: true, ms: raw };
}

/** Operator-facing reason (Vietnamese) for a refused spacing value. */
export function spacingRejectionMessage(reason: SpacingRejection): string {
  switch (reason) {
    case "NOT_A_NUMBER":
      return SPACING_MS_MESSAGES.notANumber;
    case "NOT_AN_INTEGER":
      return SPACING_MS_MESSAGES.notAnInteger;
    case "BELOW_MIN":
      return SPACING_MS_MESSAGES.belowMin;
    case "ABOVE_MAX":
      return SPACING_MS_MESSAGES.aboveMax;
  }
}

/** Which level supplied the number the gate is about to use. */
export type SpacingSource = "batch" | "tenant";

export interface ResolvedSpacing {
  readonly ms: number;
  readonly source: SpacingSource;
  /**
   * A batch value that was REFUSED at read time (out of range, fractional...),
   * so the caller can log it loudly instead of pretending it never existed.
   * Null on every normal path.
   *
   * Reachable only by a row that bypassed both write-side validations AND the
   * CHECK constraint — but "impossible" values are exactly the ones that must
   * not be allowed to decide when a real Page gets posted to.
   */
  readonly ignoredBatchSpacingMs: number | null;
}

/**
 * The run's value wins over the tenant's; absent means "tenant", which is the
 * behaviour of every batch that existed before this column.
 *
 * `0` from a batch is a VALUE, not an absence: an operator who typed 0 asked for
 * no gap, and a `??`-style fallback would quietly restore the tenant's minute.
 */
export function resolveSpacingMs(
  batchSpacingMs: number | null | undefined,
  tenantSpacingMs: number,
): ResolvedSpacing {
  if (batchSpacingMs === null || batchSpacingMs === undefined) {
    return { ms: tenantSpacingMs, source: "tenant", ignoredBatchSpacingMs: null };
  }
  if (isValidSpacingMs(batchSpacingMs)) {
    return { ms: batchSpacingMs, source: "batch", ignoredBatchSpacingMs: null };
  }
  return {
    ms: tenantSpacingMs,
    source: "tenant",
    ignoredBatchSpacingMs: typeof batchSpacingMs === "number" ? batchSpacingMs : null,
  };
}
