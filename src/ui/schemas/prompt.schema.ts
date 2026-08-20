import { z } from "zod";


/**
 * Contracts of the "Mẫu prompt" screen (E10.7).
 *
 * `ui/` may not import `core/` (docs/07 §2), so this MIRRORS
 * `core/usecases/manage-prompt-templates.ts` and the whitelist in
 * `core/ai/prompt-render.ts`. The server is still the authority: it re-checks
 * every variable and refuses with the names of the offending ones. The mirror
 * only lets the screen list the allowed variables and catch the obvious
 * mistakes before a round trip.
 */

/** Phase 1 edits the Facebook caption prompt only. */
export const PROMPT_TASK = "facebook_content";
export const PROMPT_PLATFORM = "facebook";

/** Mirror of PROMPT_VARIABLE_WHITELIST — the ONLY variables a body may use. */
export const PROMPT_VARIABLE_WHITELIST = [
  "product.name",
  "product.description",
  "product.category",
  "product.season",
  "constraints",
  "platform",
  "contentType",
  "language",
  "brandVoice",
  "otherCaptions",
  "previousFailures",
] as const;

/** Mirror of REQUIRED_PROMPT_VARIABLES for task `facebook_content`. */
export const REQUIRED_PROMPT_VARIABLES = ["product.name", "constraints"] as const;

/** What each variable carries — shown in the help box next to the form. */
export const PROMPT_VARIABLE_HINTS: Record<(typeof PROMPT_VARIABLE_WHITELIST)[number], string> = {
  "product.name": "Tên sản phẩm (bắt buộc)",
  "product.description": "Mô tả sản phẩm trong Sheet",
  "product.category": "Chủng loại",
  "product.season": "Mùa vụ",
  constraints: "Ràng buộc độ dài, hashtag, giọng văn do hệ thống dựng (bắt buộc)",
  platform: "Nền tảng đăng, ví dụ facebook",
  contentType: "Loại nội dung, ví dụ photo_post",
  language: "Ngôn ngữ đầu ra",
  brandVoice: "Giọng thương hiệu đã cấu hình",
  otherCaptions: "Caption của các kênh khác, để tránh viết trùng",
  previousFailures: "Lý do lần sinh trước bị từ chối, để lần này tránh",
};

export const PromptStatusSchema = z.enum(["draft", "active", "retired"]);
export type PromptStatus = z.infer<typeof PromptStatusSchema>;

export const PROMPT_STATUS_LABELS: Record<PromptStatus, string> = {
  draft: "Nháp",
  active: "Đang dùng",
  retired: "Đã thay thế",
};

/** Mirrors the `BadgeTone` union of ui/components/ui/badge. */
export const PROMPT_STATUS_TONES: Record<
  PromptStatus,
  "neutral" | "success" | "warning" | "danger" | "info"
> = {
  draft: "info",
  active: "success",
  retired: "neutral",
};

export const PromptSourceSchema = z.enum(["tenant", "built_in"]);
export type PromptSource = z.infer<typeof PromptSourceSchema>;

/**
 * A row of the version table. `systemPrompt` / `body` are OPTIONAL here even
 * though the server currently sends them for every row: the usecase types that
 * list as summaries, so a future change could legitimately drop the text. The
 * table degrades to "nội dung không có sẵn" instead of failing the whole parse.
 */
export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  platform: z.string().min(1),
  version: z.number(),
  status: PromptStatusSchema,
  source: PromptSourceSchema,
  variables: z.array(z.string()),
  changelog: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime().nullable(),
  systemPrompt: z.string().optional(),
  body: z.string().optional(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

/** The effective template always carries its text. */
export const PromptDetailSchema = PromptVersionSchema.extend({
  systemPrompt: z.string(),
  body: z.string(),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

export const PromptVersionListResponseSchema = z.object({
  tenantId: z.string().min(1),
  task: z.string().min(1),
  platform: z.string().min(1),
  versions: z.array(PromptVersionSchema),
  effective: PromptDetailSchema,
  nextVersion: z.number(),
});
export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

export const CreatePromptVersionResponseSchema = z.object({
  template: PromptDetailSchema,
  /** Non-blocking remarks (a recommended variable the body does not use). */
  warnings: z.array(z.string()),
});
export type CreatePromptVersionResponse = z.infer<typeof CreatePromptVersionResponseSchema>;

// --- The "tạo phiên bản mới" form -------------------------------------------

const MAX_NAME_LENGTH = 120;
const MAX_CHANGELOG_LENGTH = 2000;

export const PromptVersionFormSchema = z.object({
  // No `tenantId` (M1.4): a prompt version belongs to the company in the
  // session, so there is nothing here for the operator to type.
  name: z
    .string()
    .trim()
    .min(1, "Đặt tên cho phiên bản này, ví dụ: Giọng Tết 2027.")
    .max(MAX_NAME_LENGTH, `Tên phiên bản tối đa ${MAX_NAME_LENGTH} ký tự.`),
  systemPrompt: z.string().trim().min(1, "Nhập system prompt (vai trò và luật chung cho AI)."),
  body: z
    .string()
    .trim()
    .min(1, "Nhập nội dung prompt.")
    .refine((value) => extractPromptVariables(value).length > 0, {
      message: "Nội dung prompt chưa dùng biến nào — ít nhất phải có {{product.name}}.",
    }),
  /** Required on purpose: a version without a reason is unauditable. */
  changelog: z
    .string()
    .trim()
    .min(1, "Ghi rõ vì sao tạo phiên bản này — đây là dấu vết để truy lại sau.")
    .max(MAX_CHANGELOG_LENGTH, `Ghi chú thay đổi tối đa ${MAX_CHANGELOG_LENGTH} ký tự.`),
  activate: z.boolean(),
});
export type PromptVersionFormValues = z.infer<typeof PromptVersionFormSchema>;

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Mirrors `extractVariables` in core/ai/prompt-render.ts. */
export function extractPromptVariables(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  return [...new Set([...body.matchAll(VARIABLE_PATTERN)].map((match) => match[1]))];
}

export interface PromptVariableReport {
  variables: string[];
  /** Required by the task and absent — the server refuses to save. */
  missing: string[];
  /** Outside the whitelist — the server refuses to save. */
  unknown: string[];
}

/**
 * Local preview of the server's check. Advisory only: the answer that counts is
 * the one the API gives back, and the form shows that one verbatim.
 */
export function inspectPromptBody(body: string): PromptVariableReport {
  const variables = extractPromptVariables(body);
  const present = new Set(variables);
  const allowed = new Set<string>(PROMPT_VARIABLE_WHITELIST);
  return {
    variables,
    missing: REQUIRED_PROMPT_VARIABLES.filter((name) => !present.has(name)),
    unknown: variables.filter((name) => !allowed.has(name)),
  };
}

/** Same wording as the other screens so one app does not speak two dialects. */
export function formatPromptDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(date);
}
