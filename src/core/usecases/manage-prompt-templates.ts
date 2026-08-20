/**
 * manage-prompt-templates — the versioned prompt catalog behind screen E10.7
 * (docs/ai/prompt-versioning.md §1, ADR-001 nguyên tắc #8).
 *
 * Three invariants this usecase exists to protect:
 *  1. Rows are IMMUTABLE. "Sửa prompt" = create a NEW version; there is no
 *     update path, so every past `ai_generation` row still resolves to the exact
 *     text that produced it.
 *  2. Exactly one active version per (tenant, task, platform). Activation is one
 *     transaction in the repo, never a "deactivate then activate" pair here.
 *  3. A body may only use whitelisted variables (CLAUDE.md business rule 2).
 *     Missing REQUIRED variable or ANY non-whitelisted variable => INVALID_INPUT
 *     naming the variables; a whitelisted-but-unused recommended variable comes
 *     back as a warning, because the template still renders.
 *
 * Tenants with no row of their own run the built-in template shipped in code
 * (source: "built_in"). Nothing is seeded per tenant — see the note on
 * `resolveEffective` for why.
 */

import { z } from "zod";

import { inspectTemplateBody } from "@/core/ai/prompt-render";
import { AppError } from "@/core/domain/errors";
import { tenantIdField } from "@/core/domain/tenant-context";
import {
  AI_TASKS,
  type AITask,
  type PromptStatus,
  type PromptTemplate,
  type PromptTemplateRecord,
  type PromptTemplateRepo,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

export type PromptTemplateSource = "tenant" | "built_in";

export interface PromptTemplateSummary {
  id: string;
  name: string;
  task: AITask;
  platform: string;
  version: number;
  status: PromptStatus;
  source: PromptTemplateSource;
  variables: readonly string[];
  changelog: string;
  createdBy: string | null;
  createdAt: string | null;
}

export interface PromptTemplateDetail extends PromptTemplateSummary {
  systemPrompt: string;
  /** The user prompt template body, `{{variable}}` placeholders included. */
  body: string;
}

export interface ListPromptVersionsResult {
  /** Newest first; the built-in template is listed last as a read-only row. */
  versions: PromptTemplateSummary[];
  /** What a generation would use right now. */
  effective: PromptTemplateSummary;
  /** Version number the next `createVersion` will get. */
  nextVersion: number;
}

export interface CreatePromptVersionResult {
  template: PromptTemplateDetail;
  /** Non-blocking remarks (unused recommended variables). */
  warnings: string[];
}

export interface ManagePromptTemplatesDeps {
  templates: PromptTemplateRepo;
  /** Built-in catalog from code — the fallback every tenant starts on. */
  builtIn: readonly PromptTemplate[];
  logger: Logger;
  newId: () => string;
}

export interface ManagePromptTemplates {
  listVersions(input: unknown): Promise<ListPromptVersionsResult>;
  getActive(input: unknown): Promise<PromptTemplateDetail>;
  createVersion(input: unknown): Promise<CreatePromptVersionResult>;
  activateVersion(input: unknown): Promise<PromptTemplateDetail>;
}

// ---------------------------------------------------------------------------
// Boundary schemas — external input is parsed, never trusted (CLAUDE.md rule 2)
// ---------------------------------------------------------------------------

const targetSchema = z.object({
  tenantId: tenantIdField(),
  task: z.enum(AI_TASKS),
  platform: z.string().trim().min(1, "platform is required"),
});

const createSchema = targetSchema.extend({
  name: z.string().trim().min(1, "name is required").max(120),
  systemPrompt: z.string().trim().min(1, "systemPrompt is required"),
  body: z.string().trim().min(1, "body is required"),
  /** Required on purpose: a version without a reason is unauditable. */
  changelog: z.string().trim().min(1, "changelog is required").max(2000),
  createdBy: z.string().trim().min(1).max(200).optional(),
  activate: z.boolean().default(false),
});

const activateSchema = targetSchema.extend({
  version: z.coerce.number().int().positive(),
});

function parse<T extends z.ZodType>(schema: T, input: unknown, operation: string): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("INVALID_INPUT", {
    message: `${operation} received an invalid payload: ${issues.map((i) => i.path).join(", ")}`,
    userMessage: "Dữ liệu mẫu prompt không hợp lệ. Vui lòng kiểm tra lại các trường bắt buộc.",
    context: { operation, issues },
  });
}

// ---------------------------------------------------------------------------

export function makeManagePromptTemplates(deps: ManagePromptTemplatesDeps): ManagePromptTemplates {
  function builtInFor(task: AITask, platform: string): PromptTemplate | null {
    return (
      deps.builtIn.find(
        (template) =>
          template.task === task &&
          template.platform === platform &&
          template.tenantId === null &&
          template.status === "active",
      ) ?? null
    );
  }

  function builtInSummary(template: PromptTemplate): PromptTemplateDetail {
    const report = inspectTemplateBody(template.userPromptTemplate, template.task);
    return {
      id: template.id,
      name: template.id,
      task: template.task,
      platform: template.platform,
      version: template.version,
      status: template.status,
      source: "built_in",
      variables: report.variables,
      changelog: template.changelog,
      createdBy: null,
      createdAt: null,
      systemPrompt: template.systemPrompt,
      body: template.userPromptTemplate,
    };
  }

  function toDetail(record: PromptTemplateRecord, activeVersion: number | null): PromptTemplateDetail {
    return {
      id: record.id,
      name: record.name,
      task: record.task,
      platform: record.platform,
      version: record.version,
      status: statusOf(record, activeVersion),
      source: "tenant",
      variables: record.variables,
      changelog: record.changelog,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      systemPrompt: record.systemPrompt,
      body: record.userPromptTemplate,
    };
  }

  /**
   * The tenant row wins; the built-in template is the floor. No per-tenant seed
   * row is written at migration time on purpose: tenants are created long after
   * the migration runs, one text duplicated per tenant would drift, and fixing a
   * prompt bug would become a data migration instead of a deploy.
   */
  async function resolveEffective(
    target: z.infer<typeof targetSchema>,
  ): Promise<PromptTemplateDetail> {
    const active = await deps.templates.getActive(target);
    if (active) return toDetail(active, active.version);

    const fallback = builtInFor(target.task, target.platform);
    if (!fallback) {
      deps.logger.error("No prompt template available for task", {
        error_code: "PROMPT_NOT_FOUND",
        tenant_id: target.tenantId,
        task: target.task,
        platform: target.platform,
      });
      throw new AppError("PROMPT_NOT_FOUND", {
        message: `No tenant or built-in prompt template for task "${target.task}" on "${target.platform}"`,
        context: {
          tenant_id: target.tenantId,
          task: target.task,
          platform: target.platform,
        },
      });
    }
    return builtInSummary(fallback);
  }

  return {
    async listVersions(input) {
      const target = parse(targetSchema, input, "promptTemplates.listVersions");

      const [records, effective] = await Promise.all([
        deps.templates.listVersions(target),
        resolveEffective(target),
      ]);
      const activeVersion = records.find((record) => record.status === "active")?.version ?? null;

      const versions: PromptTemplateSummary[] = records.map((record) =>
        toDetail(record, activeVersion),
      );
      const fallback = builtInFor(target.task, target.platform);
      if (fallback) {
        // The built-in row is only "active" while the tenant has no version of
        // its own — the screen must show exactly one active row.
        versions.push({
          ...builtInSummary(fallback),
          status: activeVersion === null ? "active" : "retired",
        });
      }

      return {
        versions,
        effective,
        nextVersion: nextVersionFrom(records, fallback),
      };
    },

    async getActive(input) {
      const target = parse(targetSchema, input, "promptTemplates.getActive");
      return resolveEffective(target);
    },

    async createVersion(input) {
      const payload = parse(createSchema, input, "promptTemplates.createVersion");
      const log = deps.logger.child({
        tenant_id: payload.tenantId,
        task: payload.task,
        platform: payload.platform,
      });

      // --- Edge cases first: a body that cannot render must never be stored ---
      const report = inspectTemplateBody(payload.body, payload.task);
      if (report.missing.length > 0 || report.unknown.length > 0) {
        log.warn("Prompt version rejected: invalid variables", {
          error_code: "INVALID_INPUT",
          missing_variables: report.missing,
          unknown_variables: report.unknown,
        });
        throw new AppError("INVALID_INPUT", {
          message: `Prompt body invalid (missing: ${report.missing.join(", ") || "-"}; not whitelisted: ${report.unknown.join(", ") || "-"})`,
          userMessage: buildVariableMessage(report.missing, report.unknown),
          context: {
            tenant_id: payload.tenantId,
            task: payload.task,
            platform: payload.platform,
            missing_variables: report.missing,
            unknown_variables: report.unknown,
            allowed_variables: report.variables,
          },
        });
      }

      const records = await deps.templates.listVersions(payload);
      const fallback = builtInFor(payload.task, payload.platform);
      const version = nextVersionFrom(records, fallback);

      const created = await deps.templates.create({
        id: deps.newId(),
        tenantId: payload.tenantId,
        task: payload.task,
        platform: payload.platform,
        name: payload.name,
        version,
        systemPrompt: payload.systemPrompt,
        userPromptTemplate: payload.body,
        variables: report.variables,
        changelog: payload.changelog,
        createdBy: payload.createdBy ?? null,
        activate: payload.activate,
      });

      log.info("Prompt template version created", {
        prompt_template_id: created.id,
        prompt_version: created.version,
        activated: payload.activate,
        warnings: report.warnings.length,
      });

      return {
        template: toDetail(created, payload.activate ? created.version : (activeVersionOf(records) ?? null)),
        warnings: report.warnings,
      };
    },

    async activateVersion(input) {
      const payload = parse(activateSchema, input, "promptTemplates.activateVersion");
      const log = deps.logger.child({
        tenant_id: payload.tenantId,
        task: payload.task,
        platform: payload.platform,
      });

      const stored = await deps.templates.getVersion(payload);
      if (!stored) {
        log.warn("Cannot activate a prompt version that does not exist", {
          error_code: "PROMPT_NOT_FOUND",
          prompt_version: payload.version,
        });
        throw new AppError("PROMPT_NOT_FOUND", {
          message: `Prompt version ${payload.version} not found for task "${payload.task}"`,
          userMessage: `Không tìm thấy phiên bản prompt v${payload.version} để kích hoạt.`,
          context: {
            tenant_id: payload.tenantId,
            task: payload.task,
            platform: payload.platform,
            prompt_version: payload.version,
          },
        });
      }

      // Re-checked at activation: the whitelist may have tightened since the
      // version was drafted, and activating a broken prompt breaks generation.
      const report = inspectTemplateBody(stored.userPromptTemplate, stored.task);
      if (report.missing.length > 0 || report.unknown.length > 0) {
        log.error("Refused to activate a prompt version with invalid variables", {
          error_code: "INVALID_INPUT",
          prompt_version: payload.version,
          missing_variables: report.missing,
          unknown_variables: report.unknown,
        });
        throw new AppError("INVALID_INPUT", {
          message: `Prompt version ${payload.version} cannot be activated (missing: ${report.missing.join(", ") || "-"}; not whitelisted: ${report.unknown.join(", ") || "-"})`,
          userMessage: buildVariableMessage(report.missing, report.unknown),
          context: {
            tenant_id: payload.tenantId,
            task: payload.task,
            prompt_version: payload.version,
            missing_variables: report.missing,
            unknown_variables: report.unknown,
          },
        });
      }

      const activated = await deps.templates.activate(payload);
      if (!activated) {
        // Row vanished between read and write (concurrent delete/rollback).
        throw new AppError("PROMPT_NOT_FOUND", {
          message: `Prompt version ${payload.version} disappeared while activating`,
          context: {
            tenant_id: payload.tenantId,
            task: payload.task,
            prompt_version: payload.version,
          },
        });
      }

      log.info("Prompt template version activated", {
        prompt_template_id: activated.id,
        prompt_version: activated.version,
      });
      return toDetail(activated, activated.version);
    },
  };
}

function activeVersionOf(records: readonly PromptTemplateRecord[]): number | undefined {
  return records.find((record) => record.status === "active")?.version;
}

/** Versions never restart: they continue above the built-in and every stored row. */
function nextVersionFrom(
  records: readonly PromptTemplateRecord[],
  fallback: PromptTemplate | null,
): number {
  const highestStored = records.reduce((max, record) => Math.max(max, record.version), 0);
  const highestBuiltIn = fallback?.version ?? 0;
  return Math.max(highestStored, highestBuiltIn) + 1;
}

function statusOf(record: PromptTemplateRecord, activeVersion: number | null): PromptStatus {
  if (record.status === "active") return "active";
  if (activeVersion !== null && record.version < activeVersion) return "retired";
  return "draft";
}

function buildVariableMessage(missing: readonly string[], unknown: readonly string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`thiếu biến bắt buộc: ${missing.join(", ")}`);
  if (unknown.length > 0) parts.push(`dùng biến không được phép: ${unknown.join(", ")}`);
  return `Mẫu prompt không hợp lệ — ${parts.join("; ")}.`;
}
