import { z } from "zod";

import { MembershipRoleSchema } from "@/ui/schemas/me.schema";

/**
 * Contracts of the invite links (M2.2 API, M2.3 screen).
 *   GET    /api/invites             the links of this company — NEVER their url
 *   POST   /api/invites   {role}    mints one; the url is returned ONCE
 *   DELETE /api/invites/:id         revokes one
 *
 * SECURITY — the invite url is a CREDENTIAL: whoever holds it joins the
 * company. That is why the list endpoint does not return it, and why nothing
 * here stores it: it lives in the create mutation's answer, in memory, for as
 * long as the panel shows it (see `InvitePanel`). It is never a query key,
 * never localStorage, never a log line.
 */

/**
 * A link that is safe to put in `href` or hand to the clipboard. `z.url()`
 * alone accepts `javascript:` and `data:`, which would turn a compromised
 * answer into script execution in the operator's tab (core-frontend-security).
 */
const httpUrl = () =>
  z
    .url()
    .refine(
      (value) => /^https?:\/\//i.test(value),
      "Link mời phải bắt đầu bằng http:// hoặc https://",
    );

/** Shape recorded from the running API (GET /api/invites). */
export const InviteSchema = z.object({
  id: z.string().min(1),
  role: MembershipRoleSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  maxUses: z.number().int().min(1),
  usedCount: z.number().int().min(0),
  /** Set once revoked — revoked links stay in the list, they do not vanish. */
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  createdByEmail: z.string().nullable().optional(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const InviteListResponseSchema = z.object({
  items: z.array(InviteSchema),
});
export type InviteListResponse = z.infer<typeof InviteListResponseSchema>;

/** The ONLY answer that ever carries the url. */
export const CreateInviteResponseSchema = z.object({
  id: z.string().min(1),
  role: MembershipRoleSchema,
  url: httpUrl(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const RevokeInviteResponseSchema = z.object({
  id: z.string().min(1),
  revoked: z.literal(true),
});
export type RevokeInviteResponse = z.infer<typeof RevokeInviteResponseSchema>;

// --- Status -----------------------------------------------------------------

export const INVITE_STATUSES = ["open", "revoked", "expired", "used_up"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  open: "Đang mở",
  revoked: "Đã thu hồi",
  expired: "Đã hết hạn",
  used_up: "Đã dùng hết",
};

/** Colour never travels alone — the label above always goes with it. */
export const INVITE_STATUS_TONES: Record<InviteStatus, "success" | "neutral" | "warning"> = {
  open: "success",
  revoked: "neutral",
  expired: "warning",
  used_up: "neutral",
};

/**
 * Revoked beats expired beats used-up: an operator asking "vì sao link này
 * không dùng được" needs the reason someone ACTED on, not the one the clock
 * produced afterwards.
 */
export function inviteStatus(invite: Invite, nowMs: number): InviteStatus {
  if (invite.revokedAt !== null) return "revoked";

  const expiresAtMs = Date.parse(invite.expiresAt);
  // An unparseable date must not read as "còn hạn" — that would offer a link
  // the server is going to refuse.
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) return "expired";

  if (invite.usedCount >= invite.maxUses) return "used_up";
  return "open";
}

/** Only an open link can still be taken back. */
export function isInviteRevocable(status: InviteStatus): boolean {
  return status === "open";
}

/** "0/1 lượt" — how much of the link is left. */
export function inviteUsageLabel(invite: Invite): string {
  return `${invite.usedCount}/${invite.maxUses} lượt`;
}
