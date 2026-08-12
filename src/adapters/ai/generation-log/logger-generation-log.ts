/**
 * GenerationLog — log-only implementation.
 *
 * Production writes `ai_generation` rows (adapters/db/ai-generation-log.drizzle)
 * because the dashboard questions of prompt-versioning.md §3 need SQL. This one
 * stays for tests, smoke scripts and any process wired without a database.
 *
 * The generated text is intentionally NOT logged: it belongs in the DB column,
 * and log files are the wrong place for public-facing copy plus model output.
 * Everything needed to answer "why did this caption fail" is kept.
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
