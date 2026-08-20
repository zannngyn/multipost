/**
 * PromptStore over the templates shipped in the repo.
 *
 * This is the FLOOR every tenant starts on: `db-prompt-store.ts` looks up the
 * tenant's own active version first and falls back here when there is none
 * (docs/ai/prompt-versioning.md §1).
 */

import { AppError } from "@/core/domain/errors";
import { assertTemplateValid } from "@/core/ai/prompt-render";
import type { AITask, PromptStore, PromptTemplate } from "@/core/ports/ai";
import {
  FACEBOOK_CONTENT_TEMPLATE_V1,
  FACEBOOK_CONTENT_TEMPLATE_V2,
} from "@/adapters/ai/prompt-store/templates/facebook-content";
import { unbrandTenantId, type TenantId } from "@/core/domain/tenant-context";

/** Retired versions stay listed: the catalog is also the audit trail. */
export const BUILT_IN_TEMPLATES: readonly PromptTemplate[] = [
  FACEBOOK_CONTENT_TEMPLATE_V1,
  FACEBOOK_CONTENT_TEMPLATE_V2,
];

function keyOf(task: AITask, platform: string, tenantId: TenantId | null): string {
  return `${tenantId ? unbrandTenantId(tenantId) : "*"}|${task}|${platform}`;
}

/**
 * Fails fast when the catalog is broken: two active templates for the same
 * (tenant, task, platform), or a template missing a required variable.
 */
export function makeStaticPromptStore(
  templates: readonly PromptTemplate[] = BUILT_IN_TEMPLATES,
): PromptStore {
  const active = new Map<string, PromptTemplate>();

  for (const template of templates) {
    if (template.status !== "active") continue;
    assertTemplateValid(template);

    const key = keyOf(template.task, template.platform, template.tenantId);
    const existing = active.get(key);
    if (existing) {
      throw new AppError("INVALID_INPUT", {
        message: `Two active prompt templates for ${key}: "${existing.id}" v${existing.version} and "${template.id}" v${template.version}`,
        userMessage: "Cấu hình prompt sai: có hai bản active cho cùng một tác vụ.",
        context: { key, ids: [existing.id, template.id] },
      });
    }
    active.set(key, template);
  }

  return {
    async getActive({ tenantId, task, platform }) {
      return (
        active.get(keyOf(task, platform, tenantId)) ?? active.get(keyOf(task, platform, null)) ?? null
      );
    },
  };
}
