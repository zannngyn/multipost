import {
  CreateTenantResponseSchema,
  JoinTenantResponseSchema,
  parseInviteToken,
  type CreateTenantFormValues,
  type CreateTenantResponse,
  type JoinTenantResponse,
} from "@/ui/schemas/tenant-onboarding.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * The two doors into a company (M2.1), docs/07 §4.1.
 *   POST /api/tenants  create one — the caller becomes its owner
 *   POST /api/join     accept an invite
 *
 * Both are WRITES and are never auto-retried: a second create is a second
 * company, and both endpoints set the active-tenant cookie as a side effect,
 * so a blind repeat could also move the operator somewhere they did not ask
 * to be.
 */

export async function createTenant(
  values: CreateTenantFormValues,
  signal?: AbortSignal,
): Promise<CreateTenantResponse> {
  const name = values.name?.trim() ?? "";
  const slug = values.slug?.trim().toLowerCase() ?? "";

  // Guard: a round trip would only return the same 400 we can raise here.
  if (name.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createTenant requires a name",
      userMessage: "Nhập tên công ty trước khi tạo.",
      issues: [{ path: "name", message: "Nhập tên công ty trước khi tạo." }],
    });
  }

  return apiRequest("/api/tenants", {
    method: "POST",
    // `slug` is optional in the contract; an empty one is left out rather than
    // sent as "", which the server would have to reject.
    body: { name, ...(slug.length > 0 ? { slug } : {}) },
    schema: CreateTenantResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tạo công ty không đúng định dạng. Công ty có thể đã được tạo — hãy tải lại trang để kiểm tra.",
  });
}

/**
 * `raw` is whatever the operator pasted (a full invite link or a bare token) or
 * the token from `/join/<token>`. Extraction happens HERE, once, so the two
 * callers cannot disagree about what a token is.
 */
export async function joinTenant(raw: string, signal?: AbortSignal): Promise<JoinTenantResponse> {
  const token = parseInviteToken(raw);
  if (token === null) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      // The value itself is never echoed back — an invite token is a credential.
      message: "joinTenant requires an invite token",
      userMessage: "Không đọc được mã mời. Dán lại nguyên link mời bạn nhận được.",
      issues: [
        { path: "invite", message: "Không đọc được mã mời. Dán lại nguyên link mời bạn nhận được." },
      ],
    });
  }

  return apiRequest("/api/join", {
    method: "POST",
    body: { token },
    schema: JoinTenantResponseSchema,
    signal,
    malformedMessage:
      "Kết quả nhận lời mời không đúng định dạng. Hãy tải lại trang để xem bạn đã vào công ty chưa.",
  });
}
