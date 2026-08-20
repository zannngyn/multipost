import { z } from "zod";

import { PlatformRoleSchema, type PlatformRole } from "@/ui/schemas/me.schema";

/**
 * Contracts of the platform admin screen (M3.2): the companies MYSP itself
 * operates, seen from outside any of them.
 *
 * This is the one screen that is NOT tenant-scoped — a platform admin may hold
 * no membership anywhere. Everything here therefore addresses a company by id
 * rather than "the company of the session" (doc 09 §3.5).
 *
 * SECURITY NOTE: every rule in this file is a UX rule. `platformRole` comes
 * from `/api/me`, the server re-checks it on every call and answers 403 — the
 * ladder here only keeps someone from walking into a refusal
 * (core-auth-session: "quyền ở client là UX, không phải bảo mật").
 */

// --- Rows -------------------------------------------------------------------

export const TENANT_STATUSES = ["active", "suspended"] as const;
export const TenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  active: "Đang hoạt động",
  suspended: "Đã khoá",
};

/** Colour never travels alone — the label above always goes with it. */
export const TENANT_STATUS_TONES: Record<TenantStatus, "success" | "error"> = {
  active: "success",
  suspended: "error",
};

export const PlatformTenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Null while a company has no slug yet — cosmetic, never an identifier. */
  slug: z.string().nullable(),
  plan: z.string().min(1),
  status: TenantStatusSchema,
  memberCount: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PlatformTenant = z.infer<typeof PlatformTenantSchema>;

export const PlatformTenantListResponseSchema = z.object({
  items: z.array(PlatformTenantSchema),
});
export type PlatformTenantListResponse = z.infer<typeof PlatformTenantListResponseSchema>;

/**
 * A link that is safe to put in an input and on the clipboard. `z.url()` alone
 * accepts `javascript:` and `data:` (core-frontend-security).
 */
const httpUrl = () =>
  z
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "Link mời phải bắt đầu bằng http:// hoặc https://");

/**
 * SECURITY: `ownerInviteUrl` is a CREDENTIAL — whoever opens it becomes the
 * owner of a brand-new company. It is returned exactly once, at creation, and
 * is never stored, never a query key, never logged (same treatment as the
 * invite links in M2.3).
 */
export const CreatePlatformTenantResponseSchema = z.object({
  tenant: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().nullable(),
    plan: z.string().min(1),
    status: TenantStatusSchema,
  }),
  ownerInviteUrl: httpUrl(),
  inviteExpiresAt: z.iso.datetime({ offset: true }),
});
export type CreatePlatformTenantResponse = z.infer<typeof CreatePlatformTenantResponseSchema>;

/**
 * Suspend/activate answer. Not read: the screen re-reads the list, which is the
 * only version of the truth worth rendering after a status change.
 *
 * PENDING(platform-status-body): the contract says "tenant cập nhật" without
 * naming a shape. When it names one, this tightens into a real schema.
 */
export const PlatformTenantMutationResponseSchema = z.unknown();

// --- Support sessions (M3.3) ------------------------------------------------

export const SUPPORT_PURPOSE_MIN = 10;
export const SUPPORT_PURPOSE_MAX = 500;

/**
 * Entering a customer's company is logged in THEIR book, so it carries a
 * purpose. The minimum length is not bureaucracy: "xem thử" answers nothing to
 * the customer who reads that line later.
 */
export const StartSupportSessionFormSchema = z.object({
  purpose: z
    .string()
    .trim()
    .min(
      SUPPORT_PURPOSE_MIN,
      `Nêu mục đích, ít nhất ${SUPPORT_PURPOSE_MIN} ký tự — dòng này được ghi vào sổ của khách.`,
    )
    .max(SUPPORT_PURPOSE_MAX, `Mục đích tối đa ${SUPPORT_PURPOSE_MAX} ký tự.`),
});
export type StartSupportSessionFormValues = z.infer<typeof StartSupportSessionFormSchema>;

export const StartSupportSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  tenant: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().nullable(),
  }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type StartSupportSessionResponse = z.infer<typeof StartSupportSessionResponseSchema>;

/**
 * Leaving. Not read: `/api/me` is re-read straight afterwards, and that is the
 * only answer worth trusting about which company the browser is in.
 */
export const EndSupportSessionResponseSchema = z.unknown();

// --- The platform ladder (doc 10 §1: support < super_admin) -----------------

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  support: "Hỗ trợ (chỉ xem)",
  super_admin: "Quản trị nền tảng",
};

export function platformRoleLabel(role: PlatformRole | null): string {
  return role === null ? "Không có quyền nền tảng" : PLATFORM_ROLE_LABELS[role];
}

/** May this account open the platform screen at all? */
export function canViewPlatform(role: PlatformRole | null): boolean {
  return role !== null;
}

/**
 * Support can look; only super_admin creates a company or takes one offline.
 * Suspending is the heaviest button in the product — it locks every member of a
 * company out at once — so it lives behind the higher of the two roles.
 */
export function canAdministerPlatform(role: PlatformRole | null): boolean {
  return role === "super_admin";
}

/** Why a mutation is hidden/disabled — the sentence a disabled control needs. */
export function platformActionBlockReason(role: PlatformRole | null): string | null {
  if (canAdministerPlatform(role)) return null;
  if (role === "support") {
    return "Tài khoản hỗ trợ chỉ xem được danh sách công ty, không tạo hay khoá công ty.";
  }
  return "Bạn không có quyền quản trị nền tảng.";
}

// --- Internal tenants -------------------------------------------------------

/**
 * MYSP's own workspace, not a customer's. It is called out in the table because
 * every destructive action on it hits the team itself — the one row where
 * "khoá công ty này" means "khoá chính chúng ta".
 */
export const INTERNAL_PLAN = "internal";

export function isInternalTenant(tenant: Pick<PlatformTenant, "plan">): boolean {
  return tenant.plan.trim().toLowerCase() === INTERNAL_PLAN;
}

/**
 * The plan codes `POST /api/platform/tenants` accepts (mirrors
 * `PlatformCreateTenantRecord.plan`). The LIST endpoint still returns plan as a
 * free string — an older company may carry a code no longer on offer — so this
 * constrains what can be CREATED, never what can be displayed.
 */
export const PLATFORM_PLANS = ["standard", "internal"] as const;
export type PlatformPlan = (typeof PLATFORM_PLANS)[number];

export const PLATFORM_PLAN_LABELS: Record<PlatformPlan, string> = {
  standard: "Standard — gói cho khách",
  internal: "Internal — workspace nội bộ MYSP",
};

export function isPlatformPlan(value: string): value is PlatformPlan {
  return (PLATFORM_PLANS as readonly string[]).includes(value);
}

/** "Gói Pro" — plan is a free-form code from the server. */
export function planLabel(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed.length === 0) return "Không rõ gói";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// --- Forms ------------------------------------------------------------------

export const PLATFORM_TENANT_NAME_MAX = 80;
export const SUSPEND_REASON_MIN = 10;
export const SUSPEND_REASON_MAX = 500;

/**
 * Creating a company FOR A CUSTOMER. `slug` and `plan` are optional: the server
 * derives a slug from the name and applies the default plan when they are left
 * out, and inventing a list of plan codes on this side would be guessing.
 */
export const CreatePlatformTenantFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nhập tên công ty (ít nhất 2 ký tự).")
    .max(PLATFORM_TENANT_NAME_MAX, `Tên công ty tối đa ${PLATFORM_TENANT_NAME_MAX} ký tự.`),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(40, "Đường dẫn tối đa 40 ký tự.")
    .refine(
      (value) => value.length === 0 || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
      "Đường dẫn chỉ gồm chữ thường, số và dấu gạch ngang — ví dụ: nha-xe-an-anh.",
    ),
  /**
   * Empty = let the server apply its default. Anything else must be a code the
   * server actually accepts, so a typo cannot become a 400 round trip.
   */
  plan: z
    .string()
    .trim()
    .refine(
      (value) => value.length === 0 || isPlatformPlan(value),
      "Chọn một gói có sẵn, hoặc bỏ trống để dùng gói mặc định.",
    ),
});
export type CreatePlatformTenantFormValues = z.infer<typeof CreatePlatformTenantFormSchema>;

export const CREATE_PLATFORM_TENANT_FIELDS = ["name", "slug", "plan"] as const;
export type CreatePlatformTenantField = (typeof CREATE_PLATFORM_TENANT_FIELDS)[number];

export function isCreatePlatformTenantField(path: string): path is CreatePlatformTenantField {
  return (CREATE_PLATFORM_TENANT_FIELDS as readonly string[]).includes(path);
}

/**
 * BOTH directions need a REASON, and the server refuses a short one (verified
 * against `_lib/set-status.ts`: the same ≥10 rule guards suspend AND activate).
 * It is not bureaucracy: this row is read months later by whoever asks "vì sao
 * công ty này bị khoá / được mở lại", and "test" answers nothing.
 */
export const TenantStatusReasonFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(
      SUSPEND_REASON_MIN,
      `Nêu lý do, ít nhất ${SUSPEND_REASON_MIN} ký tự — dòng này được lưu lại.`,
    )
    .max(SUSPEND_REASON_MAX, `Lý do tối đa ${SUSPEND_REASON_MAX} ký tự.`),
});
export type TenantStatusReasonFormValues = z.infer<typeof TenantStatusReasonFormSchema>;

/** Said before the click, not discovered after it (core-crud-inline-edit §mức 2). */
export function suspendConsequence(tenant: Pick<PlatformTenant, "name" | "memberCount">): string {
  const members =
    tenant.memberCount > 0 ? `Cả ${tenant.memberCount} thành viên` : "Mọi thành viên";
  return `${members} của ${tenant.name} mất quyền vào hệ thống ngay lập tức, và bài đã hẹn của công ty này sẽ không được đăng. Dữ liệu không bị xoá — mở khoá lại là dùng tiếp được.`;
}

/** The other direction. Lighter, but still written down. */
export function activateConsequence(tenant: Pick<PlatformTenant, "name" | "memberCount">): string {
  const members =
    tenant.memberCount > 0 ? `${tenant.memberCount} thành viên` : "Thành viên";
  return `${members} của ${tenant.name} vào lại được ngay, và bài đã hẹn tiếp tục chạy theo lịch cũ.`;
}

export { PlatformRoleSchema };
