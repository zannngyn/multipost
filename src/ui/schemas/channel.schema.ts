import { z } from "zod";

/**
 * Contracts of the "Kênh" screen (E5.1) — the Fanpages a tenant may publish to.
 *
 * `ui/` may not import `core/` (docs/07 §2), so this mirrors the DTO the
 * internal API returns instead of reusing the domain type. Anything the server
 * sends is external data: it is parsed here before a component ever sees it.
 *
 * SECURITY: no access token ever appears in these shapes. The Page token lives
 * on the server; the User Access Token the operator pastes travels ONLY in a
 * POST body (see `channel.api.ts`) and is never part of a URL, a query key or
 * this module.
 */

export const CHANNEL_PLATFORMS = ["facebook", "tiktok"] as const;
export const ChannelPlatformSchema = z.enum(CHANNEL_PLATFORMS);
export type ChannelPlatform = z.infer<typeof ChannelPlatformSchema>;

export const CHANNEL_PLATFORM_LABELS: Record<ChannelPlatform, string> = {
  facebook: "Facebook",
  tiktok: "TikTok",
};

export const CHANNEL_STATUSES = ["active", "disabled"] as const;
export const ChannelStatusSchema = z.enum(CHANNEL_STATUSES);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  active: "Đang bật",
  disabled: "Đã tắt",
};

/** Colour is never the only signal — the label above always travels with it. */
export const CHANNEL_STATUS_TONES: Record<ChannelStatus, "success" | "neutral"> = {
  active: "success",
  disabled: "neutral",
};

export const ChannelSchema = z.object({
  channelId: z.string().min(1),
  platform: ChannelPlatformSchema,
  // A Page can genuinely carry a blank name; the screen renders a placeholder
  // rather than failing the whole list over one cosmetic field.
  name: z.string(),
  externalId: z.string().min(1),
  status: ChannelStatusSchema,
  // `offset: true` on purpose: a "+07:00" suffix must not kill the whole list.
  tokenExpiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelListResponseSchema = z.object({
  tenantId: z.string().min(1),
  channels: z.array(ChannelSchema),
  /**
   * Whether the server holds the key it needs to SEAL a channel's credentials.
   * Listing works without it, so this is the only way the screen can warn
   * before someone pastes a token into a write that is going to fail.
   *
   * Optional, defaulting to TRUE on purpose: a server that predates the flag
   * is not a broken server, and the screen must not lock itself out over a
   * field that simply is not there yet. A field that IS present but not a
   * boolean is still a contract break and fails like any other.
   */
  secretsConfigured: z.boolean().default(true),
});
export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>;

export const SetChannelStatusResponseSchema = z.object({
  channelId: z.string().min(1),
  status: ChannelStatusSchema,
});
export type SetChannelStatusResponse = z.infer<typeof SetChannelStatusResponseSchema>;

export const RemoveChannelResponseSchema = z.object({
  channelId: z.string().min(1),
  removed: z.literal(true),
});
export type RemoveChannelResponse = z.infer<typeof RemoveChannelResponseSchema>;

/** Shared by POST /api/channels/import and POST /api/channels/refresh. */
export const ChannelImportResponseSchema = z.object({
  tenantId: z.string().min(1),
  imported: z.number().int().min(0),
  updated: z.number().int().min(0),
  /**
   * Pages Facebook listed but did not hand a usable token for — they were NOT
   * saved, and business rule 5 says the operator must be told. Optional because
   * it is an informational counter: losing it must not fail the whole response.
   */
  skipped: z.number().int().min(0).optional(),
  channels: z.array(ChannelSchema),
});
export type ChannelImportResponse = z.infer<typeof ChannelImportResponseSchema>;

/**
 * The paste-a-token form. Local checks only catch the obvious mistakes (empty
 * box, a whole sentence pasted by accident); whether the token actually works
 * is the server's call, and its Vietnamese reason is shown as-is.
 */
export const ChannelImportFormSchema = z.object({
  userAccessToken: z
    .string()
    .trim()
    .min(1, "Dán User Access Token trước khi lấy danh sách Page.")
    .refine((value) => !/\s/.test(value), {
      message: "Token không được chứa khoảng trắng — hãy dán đúng chuỗi token, không kèm chữ khác.",
    }),
});
export type ChannelImportFormValues = z.infer<typeof ChannelImportFormSchema>;

/** Scopes the pasted token must carry, shown to the operator before they paste. */
export const REQUIRED_TOKEN_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
] as const;

/**
 * What Facebook sent us back to `/channels`. Three outcomes, three different
 * sentences — "người dùng bấm Huỷ" is NOT an error (web-auth-methods §4).
 */
export type ConnectOutcome =
  | { kind: "connected"; count: number | null }
  | { kind: "cancelled" }
  | { kind: "error"; reason: string | null };

/** Reason codes are shown as a small reference; keep them printable and short. */
const MAX_REASON_LENGTH = 64;

function safeReason(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_.:-]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_REASON_LENGTH);
}

/**
 * Query string is user-controlled input — parsed, never trusted. Returns null
 * when the URL carries no callback at all (the normal visit).
 */
export function parseConnectOutcome(params: URLSearchParams | null | undefined): ConnectOutcome | null {
  if (!params) return null;

  const connected = params.get("connected");
  if (connected !== null) {
    const count = Number.parseInt(connected, 10);
    // A malformed count still means the callback ran; say so without a number
    // rather than pretending nothing happened.
    return { kind: "connected", count: Number.isInteger(count) && count >= 0 ? count : null };
  }

  const connect = params.get("connect");
  if (connect === null) return null;
  if (connect === "cancelled") return { kind: "cancelled" };
  if (connect === "error") return { kind: "error", reason: safeReason(params.get("reason")) };

  // An outcome we do not recognise is still an outcome — never swallowed.
  return { kind: "error", reason: null };
}

/**
 * "Đã thêm 2 Page, cập nhật 1 Page." — one sentence, real numbers.
 *
 * A skipped Page is never left unsaid: it is the answer to "vì sao Page X
 * không có trong danh sách" (business rule 5).
 */
export function formatImportSummary(counts: {
  imported: number;
  updated: number;
  skipped?: number;
}): string {
  const skippedNote =
    counts.skipped && counts.skipped > 0
      ? ` Bỏ qua ${counts.skipped} Page vì Facebook không cấp token cho Page đó — kiểm tra lại quyền quản trị Page rồi lấy token mới.`
      : "";

  if (counts.imported === 0 && counts.updated === 0) {
    return `Không có Page nào thay đổi — danh sách đã khớp với Facebook.${skippedNote}`;
  }
  return `Đã thêm ${counts.imported} Page, cập nhật ${counts.updated} Page.${skippedNote}`;
}
