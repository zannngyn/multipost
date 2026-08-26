import { z } from "zod";

import { UploadResponseSchema, type UploadResponse } from "@/ui/schemas/compose.schema";

import type { UploadCandidate } from "@/ui/hooks/direct-upload-queue";
import { ApiError, CLIENT_ERROR_CODES } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * The three stages of mode B's direct-to-storage path (docs/07 §4.1). Stage
 * two is the ONLY one that carries bytes off the machine, and it goes
 * straight to MinIO — never through `apiRequest`/our own server.
 */

export const IssuedTicketSchema = z.object({
  assetId: z.string().min(1),
  fileName: z.string().min(1),
  sourceIndex: z.number().int().nonnegative(),
  postUrl: z.string().min(1),
  formFields: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type IssuedTicketDto = z.infer<typeof IssuedTicketSchema>;

export const TicketRejectionSchema = z.object({
  fileName: z.string(),
  reason: z.string(),
  userMessage: z.string(),
});

export const TicketsResponseSchema = z.object({
  issued: z.array(IssuedTicketSchema),
  rejected: z.array(TicketRejectionSchema),
});
export type TicketsResponse = z.infer<typeof TicketsResponseSchema>;

export interface RequestUploadTicketsParams {
  productCode: string;
  files: readonly UploadCandidate[];
}

/** Stage 1 — send only names/types/sizes, never bytes. */
export function requestUploadTickets(
  params: RequestUploadTicketsParams,
  signal?: AbortSignal,
): Promise<TicketsResponse> {
  const productCode = params.productCode?.trim() ?? "";
  if (productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "requestUploadTickets requires a productCode",
      userMessage: "Nhập mã sản phẩm trước khi tải file lên.",
    });
  }
  if (params.files.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "requestUploadTickets requires at least one file",
      userMessage: "Chưa chọn file nào để tải lên.",
    });
  }

  return apiRequest("/api/posts/uploads/tickets", {
    method: "POST",
    body: { productCode, files: params.files.map((file) => ({ ...file })) },
    schema: TicketsResponseSchema,
    signal,
    malformedMessage:
      "Kết quả xin vé tải lên không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface PostFileToStorageParams {
  postUrl: string;
  formFields: Readonly<Record<string, string>>;
  file: File;
}

/**
 * Stage 2 — the ONLY place bytes leave the browser, straight to the signed
 * MinIO URL. Deliberately bypasses `apiRequest`: the target is object
 * storage, not our API — sending it session headers/credentials would be a
 * mistake, not a feature.
 */
export async function postFileToStorage(
  params: PostFileToStorageParams,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  // Order matters to S3-compatible storage: every policy field must come
  // BEFORE `file`, or MinIO refuses the POST.
  for (const [key, value] of Object.entries(params.formFields)) form.append(key, value);
  form.append("file", params.file);

  let response: Response;
  try {
    response = await fetch(params.postUrl, { method: "POST", body: form, signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError({
      code: CLIENT_ERROR_CODES.NETWORK,
      status: 0,
      message: cause instanceof Error ? cause.message : String(cause),
      userMessage: `Không tải được "${params.file.name}" lên kho lưu trữ. Kiểm tra mạng rồi thử lại.`,
      cause,
    });
  }

  if (!response.ok) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.NETWORK,
      status: response.status,
      message: `Storage POST for "${params.file.name}" failed with HTTP ${response.status}`,
      userMessage: `Tải "${params.file.name}" lên kho lưu trữ thất bại (mã lỗi ${response.status}).`,
    });
  }
}

export interface ConfirmUploadParams {
  productCode: string;
  assets: readonly { assetId: string }[];
  /** Indexes into the sent album; index 0 is the cover. */
  order?: readonly number[];
}

/** Stage 3 — the bytes already sit in storage; this vets and registers them. */
export function confirmUpload(
  params: ConfirmUploadParams,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const productCode = params.productCode?.trim() ?? "";
  if (productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "confirmUpload requires a productCode",
      userMessage: "Nhập mã sản phẩm trước khi tải file lên.",
    });
  }
  if (params.assets.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "confirmUpload requires at least one asset",
      userMessage: "Chưa có file nào để xác nhận tải lên.",
    });
  }

  return apiRequest("/api/posts/uploads/confirm", {
    method: "POST",
    body: {
      productCode,
      assets: params.assets.map((asset) => ({ assetId: asset.assetId })),
      ...(params.order ? { order: [...params.order] } : {}),
    },
    schema: UploadResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tải file lên không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
