/**
 * Validation vocabulary shared by the four stages (docs/ai/validation.md §2).
 * Every stage is a pure function: (output, context) -> failures[].
 */

import type { CaptionInput } from "@/core/domain/caption";
import type { ContentConstraints } from "@/core/ports/content-engine";

export type ValidationStage = 1 | 2 | 3 | 4;

export interface ValidationFailure {
  stage: ValidationStage;
  /** Machine-readable rule id — dashboards group by this, not by message. */
  rule: string;
  /** Vietnamese, operator-facing AND fed back into the prompt when escalating. */
  message: string;
  /** Never contains raw model output — only the offending fragment. */
  detail?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  pass: boolean;
  failures: ValidationFailure[];
}

export interface ValidationContext {
  product: CaptionInput;
  constraints: ContentConstraints;
  /** Captions already accepted for other channels of the same post (D1). */
  existingCaptions: readonly string[];
}

export function failure(
  stage: ValidationStage,
  rule: string,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): ValidationFailure {
  return { stage, rule, message, detail };
}
