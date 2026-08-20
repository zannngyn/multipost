import { z } from "zod";

/**
 * Contracts of the "Quyền truy cập" screen (E10): who may sign in, and who is
 * still waiting for an admin to decide.
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * MIRROR the DTO of `/api/access-requests` instead of reusing the domain type.
 * Everything the server sends is external data — it is parsed here before a
 * component ever reads it, so a contract drift is loud instead of showing an
 * access list that quietly lost a row.
 *
 * SECURITY: nothing in these shapes is a credential. `providerAccountId` is the
 * app-scoped id the provider hands back; it identifies the account, it does not
 * authenticate it.
 */

// --- Provider ---------------------------------------------------------------

export const ACCESS_PROVIDERS = ["google", "facebook"] as const;
export const AccessProviderSchema = z.enum(ACCESS_PROVIDERS);
export type AccessProvider = z.infer<typeof AccessProviderSchema>;

export const ACCESS_PROVIDER_LABELS: Record<AccessProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

/**
 * Category tags, not system status — the non-semantic Badge colours (astryx
 * `component Badge`: success/warning/error are reserved for states that demand
 * attention, and every row here carries a provider).
 */
export const ACCESS_PROVIDER_TONES: Record<AccessProvider, "blue" | "teal"> = {
  google: "blue",
  facebook: "teal",
};

// --- Status -----------------------------------------------------------------

export const ACCESS_REQUEST_STATUSES = ["pending", "approved", "blocked"] as const;
export const AccessRequestStatusSchema = z.enum(ACCESS_REQUEST_STATUSES);
export type AccessRequestStatus = z.infer<typeof AccessRequestStatusSchema>;

export const ACCESS_REQUEST_STATUS_LABELS: Record<AccessRequestStatus, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  blocked: "Đã chặn",
};

/** Colour is never the only signal — the label above always travels with it. */
export const ACCESS_REQUEST_STATUS_TONES: Record<
  AccessRequestStatus,
  "warning" | "success" | "error"
> = {
  pending: "warning",
  approved: "success",
  blocked: "error",
};

// --- Role -------------------------------------------------------------------

export const ACCESS_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export const AccessRoleSchema = z.enum(ACCESS_ROLES);
export type AccessRole = z.infer<typeof AccessRoleSchema>;

export const ACCESS_ROLE_LABELS: Record<AccessRole, string> = {
  owner: "Chủ sở hữu",
  admin: "Quản trị",
  editor: "Biên tập",
  viewer: "Chỉ xem",
};

/**
 * What each role actually lets someone do, shown next to the label in the
 * picker. "editor" vs "admin" is meaningless on its own, and an admin picking
 * blind is how someone ends up able to approve other people by accident.
 */
export const ACCESS_ROLE_DESCRIPTIONS: Record<AccessRole, string> = {
  owner: "toàn quyền, kể cả cấu hình đơn vị",
  admin: "duyệt người dùng và đổi cấu hình",
  editor: "soạn, duyệt caption và đăng bài",
  viewer: "chỉ xem, không đăng được",
};

/** The safe default: the least power that still lets someone do the work. */
export const DEFAULT_ACCESS_ROLE: AccessRole = "editor";

export const ACCESS_DECISIONS = ["approve", "block"] as const;
export const AccessDecisionSchema = z.enum(ACCESS_DECISIONS);
export type AccessDecision = z.infer<typeof AccessDecisionSchema>;

// --- Rows -------------------------------------------------------------------

export const AccessRequestSchema = z.object({
  id: z.string().min(1),
  provider: AccessProviderSchema,
  providerAccountId: z.string().min(1),
  /**
   * Cosmetic, and genuinely absent sometimes: a provider can hand back a blank
   * name or none at all (the API's `AccessRequestView.displayName` is
   * `string | null`). The screen shows a placeholder rather than failing the
   * whole list over it — the identity of the row lives in `providerAccountId`.
   */
  displayName: z.string().nullable(),
  /**
   * Facebook does not always return an e-mail, so `null` is a NORMAL answer, not
   * missing data. Deliberately not `z.email()`: rejecting an odd-looking address
   * would drop the whole request from a list an admin has to act on, and the
   * value is only ever rendered as text.
   */
  email: z.string().nullable(),
  status: AccessRequestStatusSchema,
  /** `null` until someone is approved — a pending request has no role yet. */
  role: AccessRoleSchema.nullable(),
  // `offset: true` on purpose: a "+07:00" suffix must not kill the whole list.
  requestedAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decidedByEmail: z.string().nullable(),
});
export type AccessRequest = z.infer<typeof AccessRequestSchema>;

export const AccessRequestListResponseSchema = z.object({
  items: z.array(AccessRequestSchema),
});
export type AccessRequestListResponse = z.infer<typeof AccessRequestListResponseSchema>;

/**
 * Answer of POST /api/access-requests/decide. `role` is absent (or null) for a
 * block — there is no role to report — so it is optional here; the id and the
 * new status are not.
 */
export const AccessDecisionResponseSchema = z.object({
  id: z.string().min(1),
  status: AccessRequestStatusSchema,
  role: AccessRoleSchema.nullish(),
});
export type AccessDecisionResponse = z.infer<typeof AccessDecisionResponseSchema>;

// --- Filter (URL is the source of truth, core-data-list-query) --------------

/** "all" is a filter value, not a row status — it never reaches a row. */
export const ACCESS_FILTER_STATUSES = ["pending", "approved", "blocked", "all"] as const;
export const AccessFilterStatusSchema = z.enum(ACCESS_FILTER_STATUSES);
export type AccessFilterStatus = z.infer<typeof AccessFilterStatusSchema>;

/** Same default as the API: no `status` in the URL means "chờ duyệt". */
export const DEFAULT_ACCESS_FILTER_STATUS: AccessFilterStatus = "pending";

export const ACCESS_FILTER_LABELS: Record<AccessFilterStatus, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  blocked: "Đã chặn",
  all: "Tất cả",
};

/** Parses `?status=`; anything unrecognised falls back to the default. */
export function parseAccessFilterStatus(params: URLSearchParams): AccessFilterStatus {
  const parsed = AccessFilterStatusSchema.safeParse(params.get("status"));
  return parsed.success ? parsed.data : DEFAULT_ACCESS_FILTER_STATUS;
}

/**
 * THE single query-string builder for this screen (core-data-list-query rule
 * 1). The default is omitted so a shared link stays clean.
 */
export function accessSearchParams(status: AccessFilterStatus): URLSearchParams {
  const params = new URLSearchParams();
  if (status !== DEFAULT_ACCESS_FILTER_STATUS) params.set("status", status);
  return params;
}

// --- Display helpers ---------------------------------------------------------

/** Never renders an empty cell for a person: the row must stay identifiable. */
export function accessRequestDisplayName(request: {
  displayName: string | null;
  email: string | null;
}): string {
  const name = request.displayName?.trim() ?? "";
  if (name.length > 0) return name;

  const email = request.email?.trim() ?? "";
  if (email.length > 0) return email;

  return "(chưa có tên)";
}

/**
 * `null` means the provider sent no e-mail — that is a fact worth saying out
 * loud, not a blank cell and never the string "null".
 */
export function accessRequestEmailLabel(email: string | null): string {
  const trimmed = email?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Không có email";
}

export function hasEmail(email: string | null): boolean {
  return (email?.trim().length ?? 0) > 0;
}

/** "duyệt" / "chặn" — used inside sentences, so it stays lower case. */
export const ACCESS_DECISION_VERBS: Record<AccessDecision, string> = {
  approve: "duyệt",
  block: "chặn",
};
