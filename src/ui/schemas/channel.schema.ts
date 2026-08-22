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
   * Field-level rule (M3.3): sent to admin+ ONLY — whether the deployment is
   * missing an encryption key is a fact about the machine, not about the
   * tenant's channels. Absent therefore means "không được xem", NOT "chưa cấu
   * hình": the screen renders no warning at all rather than a warning nobody
   * on this side could act on. A field that IS present but not a boolean is
   * still a contract break and fails like any other.
   *
   * (It kept a `true` default before M3.3 so an older server would not lock the
   * screen out; the same reasoning now lands on "no field, no warning".)
   */
  secretsConfigured: z.boolean().optional(),
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
 *
 * The success outcome carries all THREE counters the callback writes
 * (`?connected=N&new=X&skipped=Y`, see `app/api/channels/callback/route.ts`):
 *   - `count`   — N, Pages saved this round (imported + updated);
 *   - `newCount`— X, of which genuinely new (`new` is a reserved word, hence
 *                 the rename; the URL spelling stays `new`);
 *   - `skipped` — Y, Pages Facebook listed but did NOT hand a usable token for.
 *                 They were not saved, and business rule 5 says the operator
 *                 must be told rather than left wondering where Page X went.
 *
 * `null` means "the callback did not send a number we can trust" — an absent
 * param, or a value that is not a plain count. It is deliberately NOT 0: the
 * banner must never claim "0 Page bị bỏ qua" from a fact nobody sent.
 */
export type ConnectOutcome =
  | { kind: "connected"; count: number | null; newCount: number | null; skipped: number | null }
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
 * A counter out of the query string: digits only, nothing else.
 *
 * `Number.parseInt` was too generous for a URL anyone can type — it reads
 * "3.7" and "3 quả" as 3. Anything that is not a plain, safe, non-negative
 * integer is `null` ("không đọc được"), never a silent default.
 */
function parseCount(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Query string is user-controlled input — parsed, never trusted. Returns null
 * when the URL carries no callback at all (the normal visit).
 */
export function parseConnectOutcome(params: URLSearchParams | null | undefined): ConnectOutcome | null {
  if (!params) return null;

  const connected = params.get("connected");
  if (connected !== null) {
    // A malformed count still means the callback ran; say so without a number
    // rather than pretending nothing happened. Each counter is read on its own,
    // so one unreadable value does not blank out the two beside it.
    return {
      kind: "connected",
      count: parseCount(connected),
      newCount: parseCount(params.get("new")),
      skipped: parseCount(params.get("skipped")),
    };
  }

  const connect = params.get("connect");
  if (connect === null) return null;
  if (connect === "cancelled") return { kind: "cancelled" };
  if (connect === "error") return { kind: "error", reason: safeReason(params.get("reason")) };

  // An outcome we do not recognise is still an outcome — never swallowed.
  return { kind: "error", reason: null };
}

export type ConnectSuccessView = {
  /** Success vs warning — the WORDS say the same thing, colour never alone. */
  tone: "success" | "warning";
  title: string;
  description: string;
};

/** Where the operator goes to check what actually landed. */
const CHECK_PAGES_HINT =
  "Kiểm tra tab “Page đã kết nối” trước khi đăng bài — chỉ những Page đang bật mới nhận bài.";

/**
 * The sentence a finished OAuth round trip gets: how many Pages came in, how
 * many of them were new, and — the part that used to be missing entirely — how
 * many Facebook refused to hand over.
 *
 * A skipped Page is the answer to "vì sao Page X không có trong danh sách"
 * (business rule 5), so it moves the banner to `warning` AND says so in words:
 * an operator reading only the title would otherwise take a warning-coloured
 * success message at face value (core-accessibility: named status).
 *
 * The counts are `null`-safe on purpose: the parser hands over "không đọc được"
 * rather than a made-up zero, and a number nobody sent is simply not mentioned.
 */
export function connectSuccessView(
  outcome: Extract<ConnectOutcome, { kind: "connected" }>,
): ConnectSuccessView {
  const { count, newCount, skipped } = outcome;
  const hasSkipped = skipped !== null && skipped > 0;

  const title =
    count === null
      ? // The round trip finished; the number it reported was unreadable.
        "Đã kết nối xong với Facebook"
      : count === 0
        ? "Không có Page nào thay đổi"
        : newCount === null
          ? `Đã nhập ${count} Page`
          : newCount === 0
            ? `Đã cập nhật ${count} Page, không có Page mới`
            : `Đã nhập ${count} Page (${newCount} mới)`;

  const skippedNote = hasSkipped
    ? `${skipped} Page bị bỏ qua — thường do thiếu quyền hoặc đã thuộc công ty khác; ` +
      "kiểm tra danh sách Page trong tài khoản Facebook. "
    : "";

  return {
    tone: hasSkipped ? "warning" : "success",
    title,
    description: `${skippedNote}${CHECK_PAGES_HINT}`,
  };
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
