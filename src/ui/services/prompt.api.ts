import {
  CreatePromptVersionResponseSchema,
  PROMPT_PLATFORM,
  PROMPT_TASK,
  PromptDetailSchema,
  PromptVersionListResponseSchema,
  type CreatePromptVersionResponse,
  type PromptDetail,
  type PromptVersionListResponse,
} from "@/ui/schemas/prompt.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the prompt catalog screen (docs/07 §4.1).
 * GET /api/prompts · POST /api/prompts · GET /api/prompts/active ·
 * POST /api/prompts/versions/:version/activate.
 *
 * Nothing here is fail-soft: a prompt the operator believes is active but is
 * not would produce wrong captions for every post that follows.
 */

export const promptKeys = {
  versions: (tenantKey: string, task: string, platform: string) =>
    ["prompts", tenantKey, task, platform, "versions"] as const,
  active: (tenantKey: string, task: string, platform: string) =>
    ["prompts", tenantKey, task, platform, "active"] as const,
};

export interface PromptTarget {
  task?: string;
  platform?: string;
}

/** Task + platform only — the company comes from the session (M1.4). */
function targetQuery(target: PromptTarget): URLSearchParams {
  return new URLSearchParams({
    task: target.task ?? PROMPT_TASK,
    platform: target.platform ?? PROMPT_PLATFORM,
  });
}

export async function listPromptVersions(
  target: PromptTarget,
  signal?: AbortSignal,
): Promise<PromptVersionListResponse> {
  return apiRequest(`/api/prompts?${targetQuery(target).toString()}`, {
    schema: PromptVersionListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách phiên bản prompt trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function fetchActivePrompt(
  target: PromptTarget,
  signal?: AbortSignal,
): Promise<PromptDetail> {
  return apiRequest(`/api/prompts/active?${targetQuery(target).toString()}`, {
    schema: PromptDetailSchema,
    signal,
    malformedMessage:
      "Prompt đang dùng trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface CreatePromptVersionParams extends PromptTarget {
  name: string;
  systemPrompt: string;
  body: string;
  changelog: string;
  activate: boolean;
}

/** Creates an IMMUTABLE new version. Never auto-retried: it is a write. */
export async function createPromptVersion(
  params: CreatePromptVersionParams,
  signal?: AbortSignal,
): Promise<CreatePromptVersionResponse> {
  const query = targetQuery(params);

  return apiRequest("/api/prompts", {
    method: "POST",
    body: {
      task: query.get("task"),
      platform: query.get("platform"),
      name: params.name,
      systemPrompt: params.systemPrompt,
      body: params.body,
      changelog: params.changelog,
      activate: params.activate,
    },
    schema: CreatePromptVersionResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tạo phiên bản không đúng định dạng. Hãy tải lại danh sách để xem phiên bản đã được tạo chưa.",
  });
}

export async function activatePromptVersion(
  params: PromptTarget & { version: number },
  signal?: AbortSignal,
): Promise<PromptDetail> {
  const query = targetQuery(params);
  const version = Number(params.version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "activatePromptVersion requires a positive version number",
      userMessage: "Số phiên bản prompt không hợp lệ.",
    });
  }

  return apiRequest(`/api/prompts/versions/${version}/activate`, {
    method: "POST",
    body: {
      task: query.get("task"),
      platform: query.get("platform"),
    },
    schema: PromptDetailSchema,
    signal,
    malformedMessage:
      "Kết quả kích hoạt không đúng định dạng. Hãy tải lại danh sách để xem phiên bản nào đang dùng.",
  });
}
