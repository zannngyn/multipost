import { and, desc, eq } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type {
  AITask,
  NewPromptTemplate,
  PromptTemplateQuery,
  PromptTemplateRecord,
  PromptTemplateRepo,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

import type { Database, DbExecutor } from "./client";
import { isPgError, wrapDbError } from "./db-errors";
import { aiPromptTemplates, type AiPromptTemplateRow } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * `ai_prompt_template` persistence (docs/ai/prompt-versioning.md §1).
 *
 * Rows are immutable: there is no update method. `activate` flips `is_active`
 * inside ONE transaction, and the partial unique index
 * `ai_prompt_template_active_uq` is the real authority — two concurrent
 * activations cannot both win, whatever order the statements run in.
 */

const PG_UNIQUE_VIOLATION = "23505";

function versionTaken(query: PromptTemplateQuery, version: number, error: unknown): AppError {
  return new AppError("INVALID_INPUT", {
    message: `Prompt version ${version} already exists for task "${query.task}"`,
    userMessage: `Phiên bản prompt v${version} đã tồn tại — hãy tải lại danh sách rồi tạo lại.`,
    context: {
      tenant_id: query.tenantId,
      task: query.task,
      platform: query.platform,
      prompt_version: version,
      reason: "PROMPT_VERSION_TAKEN",
    },
    cause: error,
  });
}

/**
 * `task` is taken from the (already validated) query, not from the row: the
 * column is free text in the database, and casting a stored string to AITask
 * would be exactly the "trust external data" mistake ports exist to prevent.
 */
function toRecord(row: AiPromptTemplateRow, task: AITask): PromptTemplateRecord {
  return {
    id: row.id,
    task,
    platform: row.platform,
    tenantId: row.tenantId,
    version: row.version,
    status: row.isActive ? "active" : "draft",
    systemPrompt: row.systemPrompt,
    userPromptTemplate: row.body,
    changelog: row.changelog,
    name: row.name,
    variables: Array.isArray(row.variables)
      ? row.variables.filter((value): value is string => typeof value === "string")
      : [],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleAiPromptTemplateRepo implements PromptTemplateRepo {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  private scopeOf(query: PromptTemplateQuery, operation: string, executor: DbExecutor = this.db) {
    const platform = typeof query?.platform === "string" ? query.platform.trim() : "";
    if (platform.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: `${operation} requires a platform`,
        userMessage: "Thiếu nền tảng (platform) của mẫu prompt.",
        context: { tenant_id: query?.tenantId ?? null, task: query?.task ?? null, operation },
      });
    }
    return { scope: forTenant(executor, query.tenantId), platform };
  }

  private target(query: PromptTemplateQuery, platform: string, executor: DbExecutor = this.db) {
    const scope = forTenant(executor, query.tenantId);
    return scope.where(
      aiPromptTemplates,
      eq(aiPromptTemplates.task, query.task),
      eq(aiPromptTemplates.platform, platform),
    );
  }

  async listVersions(query: PromptTemplateQuery): Promise<readonly PromptTemplateRecord[]> {
    const { scope, platform } = this.scopeOf(query, "promptTemplate.listVersions");
    try {
      const rows = await scope.db
        .select()
        .from(aiPromptTemplates)
        .where(this.target(query, platform))
        .orderBy(desc(aiPromptTemplates.version));
      return rows.map((row) => toRecord(row, query.task));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "promptTemplate.listVersions",
        tenant_id: scope.tenantId,
        task: query.task,
        platform,
      });
    }
  }

  async getActive(query: PromptTemplateQuery): Promise<PromptTemplateRecord | null> {
    const { scope, platform } = this.scopeOf(query, "promptTemplate.getActive");
    try {
      const rows = await scope.db
        .select()
        .from(aiPromptTemplates)
        .where(and(this.target(query, platform), eq(aiPromptTemplates.isActive, true)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row, query.task) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "promptTemplate.getActive",
        tenant_id: scope.tenantId,
        task: query.task,
        platform,
      });
    }
  }

  async getVersion(
    query: PromptTemplateQuery & { version: number },
  ): Promise<PromptTemplateRecord | null> {
    const { scope, platform } = this.scopeOf(query, "promptTemplate.getVersion");
    try {
      const rows = await scope.db
        .select()
        .from(aiPromptTemplates)
        .where(and(this.target(query, platform), eq(aiPromptTemplates.version, query.version)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row, query.task) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "promptTemplate.getVersion",
        tenant_id: scope.tenantId,
        task: query.task,
        platform,
        prompt_version: query.version,
        field: "version",
      });
    }
  }

  async maxVersion(query: PromptTemplateQuery): Promise<number> {
    const { scope, platform } = this.scopeOf(query, "promptTemplate.maxVersion");
    try {
      const rows = await scope.db
        .select({ version: aiPromptTemplates.version })
        .from(aiPromptTemplates)
        .where(this.target(query, platform))
        .orderBy(desc(aiPromptTemplates.version))
        .limit(1);
      return rows[0]?.version ?? 0;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "promptTemplate.maxVersion",
        tenant_id: scope.tenantId,
        task: query.task,
        platform,
      });
    }
  }

  /**
   * Insert-only. When `activate` is set, the deactivate + insert pair runs in
   * one transaction so there is never a window with zero or two active rows.
   */
  async create(input: NewPromptTemplate): Promise<PromptTemplateRecord> {
    const { platform } = this.scopeOf(input, "promptTemplate.create");
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "promptTemplate.create requires an id",
        userMessage: "Thiếu mã định danh của mẫu prompt.",
        context: { tenant_id: input?.tenantId ?? null, task: input?.task ?? null },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        if (input.activate) {
          await tx
            .update(aiPromptTemplates)
            .set({ isActive: false, updatedAt: new Date() })
            .where(and(this.target(input, platform, tx), eq(aiPromptTemplates.isActive, true)));
        }

        const scope = forTenant(tx, input.tenantId);
        const rows = await tx
          .insert(aiPromptTemplates)
          .values(
            scope.row({
              id,
              task: input.task,
              platform,
              name: input.name,
              systemPrompt: input.systemPrompt,
              body: input.userPromptTemplate,
              variables: [...input.variables],
              version: input.version,
              isActive: input.activate,
              changelog: input.changelog,
              createdBy: input.createdBy ?? null,
            }),
          )
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError("DB_ERROR", {
            message: "Insert returned no ai_prompt_template row",
            context: { tenant_id: input.tenantId, task: input.task, version: input.version },
          });
        }
        return toRecord(row, input.task);
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        this.logger.warn("Prompt version collision", {
          error_code: "INVALID_INPUT",
          tenant_id: input.tenantId,
          task: input.task,
          platform,
          prompt_version: input.version,
        });
        throw versionTaken(input, input.version, error);
      }
      throw wrapDbError(error, {
        operation: "promptTemplate.create",
        tenant_id: input.tenantId,
        task: input.task,
        platform,
        prompt_version: input.version,
      });
    }
  }

  async activate(
    query: PromptTemplateQuery & { version: number },
  ): Promise<PromptTemplateRecord | null> {
    const { platform } = this.scopeOf(query, "promptTemplate.activate");

    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .update(aiPromptTemplates)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(this.target(query, platform, tx), eq(aiPromptTemplates.isActive, true)));

        const rows = await tx
          .update(aiPromptTemplates)
          .set({ isActive: true, updatedAt: new Date() })
          .where(
            and(this.target(query, platform, tx), eq(aiPromptTemplates.version, query.version)),
          )
          .returning();

        const row = rows[0];
        // No row: the version does not exist. Rolling back keeps the previous
        // active template in place instead of leaving the tenant with none.
        if (!row) {
          throw new AppError("PROMPT_NOT_FOUND", {
            message: `Prompt version ${query.version} not found while activating`,
            context: {
              tenant_id: query.tenantId,
              task: query.task,
              platform,
              prompt_version: query.version,
              reason: "ACTIVATE_ROLLBACK",
            },
          });
        }
        return toRecord(row, query.task);
      });
    } catch (error) {
      if (AppError.is(error) && error.context.reason === "ACTIVATE_ROLLBACK") {
        this.logger.warn("Activation rolled back: version not found", {
          error_code: "PROMPT_NOT_FOUND",
          tenant_id: query.tenantId,
          task: query.task,
          platform,
          prompt_version: query.version,
        });
        return null;
      }
      throw wrapDbError(error, {
        operation: "promptTemplate.activate",
        tenant_id: query.tenantId,
        task: query.task,
        platform,
        prompt_version: query.version,
        field: "version",
      });
    }
  }
}
