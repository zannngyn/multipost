/**
 * PromptStore backed by `ai_prompt_template`, with the built-in templates from
 * code as the floor (docs/ai/prompt-versioning.md §1).
 *
 * Lookup order: tenant's ACTIVE row -> built-in template. Nothing is seeded per
 * tenant at migration time on purpose:
 *   - tenants are created long after a migration runs, so a seed would only
 *     cover the tenants that existed that day;
 *   - the same text copied per tenant drifts, and "fix the prompt for everyone"
 *     would become a data migration instead of a deploy;
 *   - a tenant row then means exactly one thing: "this tenant customised it".
 *
 * A DATABASE failure is NOT a reason to fall back to the built-in text: that
 * would quietly publish content written by a prompt version the operator
 * retired. The error is logged and rethrown.
 */

import { AppError } from "@/core/domain/errors";
import { normalizeTenantId } from "@/core/domain/tenant-context";
import type { PromptStore, PromptTemplate, PromptTemplateRepo } from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

export interface DbPromptStoreDeps {
  repo: PromptTemplateRepo;
  /** Built-in catalog (static store) used when the tenant has no active row. */
  builtIn: PromptStore;
  logger: Logger;
}

export function makeDbPromptStore(deps: DbPromptStoreDeps): PromptStore {
  return {
    async getActive(query): Promise<PromptTemplate | null> {
      const rawTenantId = typeof query?.tenantId === "string" ? query.tenantId.trim() : "";
      if (!rawTenantId) {
        throw new AppError("INVALID_INPUT", {
          message: "PromptStore.getActive requires a tenantId",
          userMessage: "Thiếu mã đơn vị (tenant) khi tra mẫu prompt.",
          context: { task: query?.task ?? null, platform: query?.platform ?? null },
        });
      }
      const tenantId = normalizeTenantId(query.tenantId);

      let stored;
      try {
        stored = await deps.repo.getActive({ ...query, tenantId });
      } catch (error) {
        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId,
          task: query.task,
          platform: query.platform,
          operation: "promptStore.getActive",
        });
        deps.logger.error("Cannot read the tenant prompt template", {
          error_code: appError.code,
          tenant_id: tenantId,
          task: query.task,
          platform: query.platform,
          err: appError,
        });
        throw appError;
      }

      if (stored) {
        deps.logger.debug("Prompt template resolved from tenant catalog", {
          tenant_id: tenantId,
          task: query.task,
          platform: query.platform,
          prompt_template_id: stored.id,
          prompt_version: stored.version,
          prompt_source: "tenant",
        });
        return stored;
      }

      const fallback = await deps.builtIn.getActive({ ...query, tenantId });
      deps.logger.debug("Prompt template resolved from built-in catalog", {
        tenant_id: tenantId,
        task: query.task,
        platform: query.platform,
        prompt_template_id: fallback?.id ?? null,
        prompt_version: fallback?.version ?? null,
        prompt_source: "built_in",
      });
      return fallback;
    },
  };
}
