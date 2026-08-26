import { z } from "zod";

import { MembershipRoleSchema } from "@/ui/schemas/me.schema";

/**
 * Contracts of the two ways into a company (M2.1 + first half of M2.3):
 *   POST /api/tenants  — create one, and become its owner
 *   POST /api/join     — accept an invite
 *
 * Both answers carry the company the operator is now working in, and the server
 * sets the active-tenant cookie itself — the UI never selects a company it was
 * not told about (docs/09 Q5: the cookie is a selector, not authorisation).
 *
 * ONE schema per form, `z.infer` for the type (core-form-architecture): there is
 * no hand-written interface next to any of these.
 */

// --- Shared shape -----------------------------------------------------------

/**
 * Mirrors `MeTenant`, with ONE deliberate tolerance: `role` is optional, because
 * create returns it inside `tenant` while join returns it next to `tenant`, and
 * neither path needs it to continue (the app re-reads `/api/me` right after).
 *
 * `id` is required and is the only accepted spelling — both endpoints now answer
 * the same shape as `/api/me`, so nothing downstream has to know which door the
 * company came through.
 */
export const OnboardedTenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().nullable(),
  plan: z.string().min(1),
  role: MembershipRoleSchema.optional(),
});
export type OnboardedTenant = z.infer<typeof OnboardedTenantSchema>;

export const CreateTenantResponseSchema = z.object({
  tenant: OnboardedTenantSchema,
  activeTenantId: z.string().min(1),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

export const JoinTenantResponseSchema = z.object({
  tenant: OnboardedTenantSchema,
  role: MembershipRoleSchema,
  /**
   * The invite pointed at a company this account already belongs to. Not an
   * error — but a different sentence: "đã vào" and "vốn đã ở trong" are two
   * different things to be told.
   */
  alreadyMember: z.boolean().optional().default(false),
});
export type JoinTenantResponse = z.infer<typeof JoinTenantResponseSchema>;

/**
 * `POST /api/tenants/ensure-default` (E10) — the THIRD door, and the only one
 * nobody knocks on: the first-run gate calls it for an account that belongs
 * nowhere, and it is written to be safe to call on every entry.
 *
 * `wasCreated` is the whole payload's reason for existing. `201` + a moved
 * active-tenant cookie means a company was just minted for this account; `200`
 * means it already had one and the cookie was NOT touched — reading that as
 * "we selected a company for you" is how an operator with several companies
 * gets yanked out of the one they were working in.
 */
export const EnsureDefaultTenantResponseSchema = z.object({
  tenantId: z.string().min(1),
  wasCreated: z.boolean(),
});
export type EnsureDefaultTenantResponse = z.infer<typeof EnsureDefaultTenantResponseSchema>;

// --- Slug -------------------------------------------------------------------

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;
export const TENANT_NAME_MAX_LENGTH = 80;

/** Lowercase, digits and single dashes — what a URL segment may hold. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * "Nhà Xe An Anh" -> "nha-xe-an-anh".
 *
 * NFD splits Vietnamese tone marks into the combining range, but leaves đ/Đ
 * whole — those are separate letters, not accented d, and need their own pass.
 *
 * [dup-2/3] Same normalisation as `toSearchKey` in shell/nav-items.ts, which
 * lowercases for search instead of building a URL segment. A third use means
 * extracting one helper (core-component-reuse, Rule of 3).
 */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    // Slicing can leave a trailing dash behind ("nha-xe-" -> "nha-xe").
    .replace(/-+$/g, "");
}

// --- The "tạo công ty" form -------------------------------------------------

export const CreateTenantFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nhập tên công ty (ít nhất 2 ký tự).")
    .max(TENANT_NAME_MAX_LENGTH, `Tên công ty tối đa ${TENANT_NAME_MAX_LENGTH} ký tự.`),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(SLUG_MIN_LENGTH, `Đường dẫn cần ít nhất ${SLUG_MIN_LENGTH} ký tự.`)
    .max(SLUG_MAX_LENGTH, `Đường dẫn tối đa ${SLUG_MAX_LENGTH} ký tự.`)
    .regex(
      SLUG_PATTERN,
      "Đường dẫn chỉ gồm chữ thường, số và dấu gạch ngang — ví dụ: nha-xe-an-anh.",
    ),
});
export type CreateTenantFormValues = z.infer<typeof CreateTenantFormSchema>;

/** Field names the server may report issues on — used to place them inline. */
export const CREATE_TENANT_FIELDS = ["name", "slug"] as const;
export type CreateTenantField = (typeof CREATE_TENANT_FIELDS)[number];

export function isCreateTenantField(path: string): path is CreateTenantField {
  return (CREATE_TENANT_FIELDS as readonly string[]).includes(path);
}

// --- The "dán link mời" form ------------------------------------------------

/**
 * Deliberately loose: the token format belongs to the server, and a second,
 * stricter copy here would reject invites the server would have accepted. This
 * only catches what costs a round trip — an empty box, or a whole sentence
 * pasted by accident.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{6,256}$/;

const INVITE_HELP =
  "Dán nguyên link mời (ví dụ https://…/join/abc123) hoặc riêng mã mời trong link đó.";

/**
 * Accepts a pasted browser link OR a bare token, because that is what an
 * operator actually has in their clipboard. Returns null when the input holds
 * no token shape at all — the caller turns that into a field error.
 */
export function parseInviteToken(raw: string): string | null {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (input.length === 0) return null;

  // A link, absolute or relative. Query string and hash are dropped: an invite
  // mail client may append tracking parameters.
  const fromLink = /\/join\/([^/?#\s]+)/.exec(input);
  const candidate = fromLink ? decodeToken(fromLink[1]) : input;

  if (!TOKEN_PATTERN.test(candidate)) return null;
  return candidate;
}

/** A token that travelled through a mailer may arrive percent-encoded. */
function decodeToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding: keep the raw text and let the pattern judge.
    return value;
  }
}

/**
 * A bad token now answers 404 `INVITE_INVALID`, same as an expired or revoked
 * one — so the only field-level message this form can receive is the one raised
 * on THIS side, under the box's own name (`invite`), when the pasted text holds
 * no token shape at all. The API's remaining 400 means the request carried no
 * `token` field, which is a client bug the operator cannot fix by editing the
 * box; it surfaces as the general notice instead of being dressed up as a field
 * error on a box they did fill in.
 */
export const INVITE_FIELD_PATH = "invite";

export const JoinInviteFormSchema = z.object({
  invite: z
    .string()
    .trim()
    .min(1, `Dán link mời trước khi tiếp tục. ${INVITE_HELP}`)
    .refine((value) => parseInviteToken(value) !== null, {
      message: `Không đọc được mã mời trong nội dung vừa dán. ${INVITE_HELP}`,
    }),
});
export type JoinInviteFormValues = z.infer<typeof JoinInviteFormSchema>;

/** "Bạn đã vào Nhà Xe An Anh với vai trò Biên tập." */
export function joinSuccessMessage(result: JoinTenantResponse, roleLabel: string): string {
  if (result.alreadyMember) {
    return `Bạn đã là thành viên của ${result.tenant.name} với vai trò ${roleLabel}. Không có gì thay đổi.`;
  }
  return `Bạn đã vào ${result.tenant.name} với vai trò ${roleLabel}.`;
}
