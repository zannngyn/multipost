import { z } from "zod";

import { MEMBERSHIP_ROLE_LABELS, MembershipRoleSchema, type MembershipRole } from "@/ui/schemas/me.schema";

/**
 * Contracts of the "Thành viên" screen (M2.3): who is in this company, and what
 * each of them may do.
 *
 * `ui/` may not import `core/` (docs/07 §2), so this mirrors the DTO of
 * `/api/members`. Everything here is external data — parsed before a component
 * reads it, because a half-parsed permissions list is the one list that must
 * never be half-right.
 *
 * SECURITY NOTE: every rule in this file is a UX rule. The server decides
 * (doc 10 §2, tier S) and answers 403/409 — the ladder here only keeps an
 * operator from walking into a refusal (core-auth-session: "quyền ở client là
 * UX, không phải bảo mật").
 */

// --- Rows -------------------------------------------------------------------

export const MemberSchema = z.object({
  membershipId: z.string().min(1),
  accountId: z.string().min(1),
  /** Cosmetic and genuinely absent sometimes — the row stays identifiable. */
  displayName: z.string().nullable(),
  /** Null is NORMAL: a Facebook account may carry no address. */
  email: z.string().nullable(),
  role: MembershipRoleSchema,
  /**
   * The contract lists active members only. Kept as a free string so a status
   * added later shows up as itself instead of failing the whole screen — an
   * unknown status is rendered verbatim, never flattened into "đang hoạt động".
   */
  status: z.string().min(1),
  joinedAt: z.iso.datetime({ offset: true }),
  /** The row that is the signed-in operator. Server-decided, never inferred. */
  isYou: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const MemberListResponseSchema = z.object({
  items: z.array(MemberSchema),
});
export type MemberListResponse = z.infer<typeof MemberListResponseSchema>;

/**
 * PUT/DELETE answers are not read: the screen re-reads the list (and `/api/me`
 * when the change is about the operator themselves), which is the only version
 * of the truth worth rendering after a permissions change.
 *
 * PENDING(member-mutation-body): the contract does not name a response shape.
 * When it does, this tightens into a real schema.
 */
export const MemberMutationResponseSchema = z.unknown();

export const MEMBER_STATUS_LABELS: Record<string, string> = {
  active: "Đang hoạt động",
  suspended: "Đã tạm ngưng",
  removed: "Đã gỡ",
};

export function memberStatusLabel(status: string): string {
  return MEMBER_STATUS_LABELS[status] ?? status;
}

/** Never renders an anonymous row: name → email → a plain label. */
export function memberDisplayName(member: Pick<Member, "displayName" | "email">): string {
  const name = member.displayName?.trim() ?? "";
  if (name.length > 0) return name;

  const email = member.email?.trim() ?? "";
  if (email.length > 0) return email;

  return "(chưa có tên)";
}

// --- The role ladder (doc 10 §1: viewer < editor < admin < owner) ------------

export const ROLE_RANK: Record<MembershipRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

/**
 * Roles the actor may GRANT — when inviting, and when changing someone's role.
 *
 * An admin owns "cấu hình + credential" but not the tenant's lifecycle, so they
 * cannot mint another admin or an owner: that is how an admin would quietly
 * promote themselves past their own ceiling.
 */
export function assignableRoles(actor: MembershipRole | null): readonly MembershipRole[] {
  if (actor === "owner") return ["owner", "admin", "editor", "viewer"];
  if (actor === "admin") return ["editor", "viewer"];
  return [];
}

/**
 * Why the actor may not touch this member at all — or null when they may.
 *
 * The sentence is the point: a disabled control with no reason is the thing
 * core-auth-session forbids, and "vì sao nút này xám" is the first question an
 * operator asks.
 */
export function memberActionBlockReason(
  actor: MembershipRole | null,
  member: Pick<Member, "role" | "isYou">,
): string | null {
  if (actor === null) return "Chưa xác định được vai trò của bạn trong công ty này.";
  if (actor === "owner") return null;

  if (actor !== "admin") {
    return "Chỉ chủ sở hữu và quản trị viên mới quản lý được thành viên.";
  }

  // Admin: everyone below them, plus themselves (leaving is allowed).
  if (member.isYou) return null;
  if (ROLE_RANK[member.role] >= ROLE_RANK.admin) {
    return "Quản trị viên không thao tác được trên quản trị viên hoặc chủ sở hữu khác — nhờ chủ sở hữu công ty.";
  }
  return null;
}

/** Why the actor may not grant THIS role — or null when they may. */
export function roleChangeBlockReason(
  actor: MembershipRole | null,
  member: Pick<Member, "role" | "isYou">,
  nextRole: MembershipRole,
): string | null {
  const blocked = memberActionBlockReason(actor, member);
  if (blocked) return blocked;

  if (!assignableRoles(actor).includes(nextRole)) {
    return `Bạn không cấp được vai trò ${MEMBERSHIP_ROLE_LABELS[nextRole]}.`;
  }
  if (nextRole === member.role) return "Thành viên này đã ở vai trò đó.";
  return null;
}

/** True when the actor can do anything at all on this screen. */
export function canManageMembers(actor: MembershipRole | null): boolean {
  return actor === "owner" || actor === "admin";
}

/** "Bạn đang gỡ chính mình" — the sentence that has to be said out loud. */
export function removeMemberConsequence(member: Pick<Member, "isYou">): string {
  if (member.isYou) {
    return "Bạn sẽ mất quyền vào công ty này ngay lập tức và cần được mời lại để quay lại. Dữ liệu của công ty không bị xoá.";
  }
  return "Người này sẽ mất quyền vào công ty ngay lập tức và cần một link mời mới để quay lại. Bài đã đăng và dữ liệu của công ty không bị xoá.";
}
