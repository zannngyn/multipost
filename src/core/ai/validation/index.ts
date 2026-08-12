/**
 * Validation pipeline — schema -> business -> claim -> content policy
 * (docs/ai/validation.md §2). Pure: same input, same verdict, no I/O.
 *
 * Stage 1 short-circuits (later stages need a typed object); stages 2–4 all run
 * so one escalation carries EVERY reason back into the prompt instead of
 * fixing one problem per round trip.
 */

import type { GeneratedContent } from "@/core/ai/generated-content";
import { validateBusiness } from "@/core/ai/validation/business";
import { validateClaims } from "@/core/ai/validation/claim";
import { validateContentPolicy } from "@/core/ai/validation/content-policy";
import { validateSchema } from "@/core/ai/validation/schema";
import type { ValidationContext, ValidationFailure, ValidationResult } from "@/core/ai/validation/types";

export * from "@/core/ai/validation/types";
export { validateSchema } from "@/core/ai/validation/schema";
export { validateBusiness } from "@/core/ai/validation/business";
export { validateClaims } from "@/core/ai/validation/claim";
export { validateContentPolicy } from "@/core/ai/validation/content-policy";

export interface PipelineResult extends ValidationResult {
  /** Present only when stage 1 passed. */
  content?: GeneratedContent;
  /** Stage that produced the first failure — routes the final error code. */
  firstFailedStage?: 1 | 2 | 3 | 4;
}

export function validateGeneratedContent(
  output: unknown,
  context: ValidationContext,
): PipelineResult {
  const schema = validateSchema(output);
  if (!schema.ok || !schema.content) {
    return { pass: false, failures: schema.failures, firstFailedStage: 1 };
  }

  const content = schema.content;
  const failures: ValidationFailure[] = [
    ...validateBusiness(content, context),
    ...validateClaims(content, context),
    ...validateContentPolicy(content, context),
  ];

  if (failures.length === 0) return { pass: true, failures: [], content };

  return {
    pass: false,
    failures,
    content,
    firstFailedStage: failures[0].stage,
  };
}

/** Escalation feedback: why the previous attempt was rejected (model-routing.md §3). */
export function describeFailures(failures: readonly ValidationFailure[]): string {
  return failures.map((item) => `- [${item.rule}] ${item.message}`).join("\n");
}
