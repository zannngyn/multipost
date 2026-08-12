/**
 * GenerationLog — log-only implementation for this sprint.
 *
 * TODO(ADR-001, sprint tích hợp): replace with the `ai_generation` table
 * (docs/ai/prompt-versioning.md §2) — the dashboard questions in §3 (cost per
 * published post, pass rate per model, fallback rate) need SQL, not log files.
 *
 * The generated text is intentionally NOT logged: it belongs in the future DB
 * column, and log files are the wrong place for public-facing copy plus model
 * output. Everything needed to answer "why did this caption fail" is kept.
 */

import type { GenerationLog, GenerationLogEntry } from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

export function makeLoggerGenerationLog(logger: Logger): GenerationLog {
  return {
    async record(entry: GenerationLogEntry): Promise<void> {
      const { output: _output, ...rest } = entry;
      logger.info("ai_generation", {
        ...rest,
        validation_failure_rules: entry.validationFailures?.map((item) => item.rule) ?? [],
        output_stored: entry.output !== undefined,
      });
    },
  };
}
