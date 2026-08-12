import { eq } from "drizzle-orm";

import { parseModelPolicyOverride } from "@/core/ai/model-policy-override";
import type {
  AITask,
  ModelPolicyOverrideRecord,
  ModelPolicyOverrideRepo,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { aiModelPolicyOverrides } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * `ai_model_policy_override` reader — the DB half of the registry
 * (ADR-001: YAML in repo + per-tenant override, hot-cached in Redis).
 *
 * The jsonb blob is parsed through the core schema before it leaves this class:
 * a malformed override raises MODEL_NOT_CONFIGURED naming the bad field instead
 * of silently reverting to the YAML defaults (CLAUDE.md rule 2 — no silent
 * fallback on failed validation).
 */
export class DrizzleAiModelPolicyOverrideRepo implements ModelPolicyOverrideRepo {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async findOverride(query: {
    tenantId: string;
    task: AITask;
  }): Promise<ModelPolicyOverrideRecord | null> {
    const scope = forTenant(this.db, query?.tenantId ?? "");

    let row;
    try {
      const rows = await scope.db
        .select()
        .from(aiModelPolicyOverrides)
        .where(scope.where(aiModelPolicyOverrides, eq(aiModelPolicyOverrides.task, query.task)))
        .limit(1);
      row = rows[0];
    } catch (error) {
      throw wrapDbError(error, {
        operation: "aiModelPolicyOverride.find",
        tenant_id: scope.tenantId,
        task: query.task,
      });
    }

    if (!row) return null;

    // Outside the try: a schema failure is a config error, not a DB_ERROR.
    const override = parseModelPolicyOverride(row.override, {
      tenantId: scope.tenantId,
      task: query.task,
    });

    this.logger.debug("Tenant model policy override loaded", {
      tenant_id: scope.tenantId,
      task: query.task,
      override_keys: Object.keys(override),
    });

    return {
      tenantId: scope.tenantId,
      task: query.task,
      override,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
