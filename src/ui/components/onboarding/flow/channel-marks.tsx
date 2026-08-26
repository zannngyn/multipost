/**
 * The eight channel marks, drawn here because nothing else in the repo has
 * them: `lucide-react` REMOVED every brand glyph over trademark concerns, and
 * there is no `public/` asset, no icon component, nothing. Drawn ONCE, in one
 * file, because two screens need them — the welcome backdrop (spec section 4)
 * and the step-4 channel tiles (spec section 5.4, task 8).
 *
 * SIMPLIFIED, NOT OFFICIAL. These are recognisable silhouettes at 24-40px, not
 * brand assets: do not put them on anything that speaks for the brand. Replace
 * them with the real files the day MYSP is allowed to ship them.
 *
 * BRAND COLOURS ARE LITERALS, AND ONLY HERE. Every other colour in this flow is
 * a token — `CLAUDE.md` and spec section 10 are explicit about that — but a
 * channel's own colour is a fact about somebody else's identity, not a decision
 * this design system gets to make, so no `--color-*` would be correct. They are
 * literals for the same reason a logo file is a literal. NOTHING may read
 * `CHANNEL_BRAND_COLOR` for a UI surface, a border or a piece of text.
 *
 * Every mark takes the same props and paints with `currentColor`, so the caller
 * decides how loud it is. All of them are decoration or are labelled by their
 * own visible text, so none carries an accessible name; a caller that shows a
 * mark ALONE has to name it (spec section 9.6).
 */

import type { ReactElement } from "react";

export const CHANNEL_MARK_IDS = [
  "facebook",
  "tiktok",
  "instagram",
  "youtube",
  "threads",
  "zalo_oa",
  "shopee",
  "lazada",
] as const;

export type ChannelMarkId = (typeof CHANNEL_MARK_IDS)[number];

export interface ChannelMarkProps {
  readonly className?: string;
}

function FacebookMark({ className }: ChannelMarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.51 1.49-3.9 3.78-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12Z" />
    </svg>
  );
}

function TiktokMark({ className }: ChannelMarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M16.5 2h-3v13.1a2.6 2.6 0 1 1-2.1-2.55V9.5a5.7 5.7 0 1 0 5.1 5.67V9.06A7.2 7.2 0 0 0 21 10.5V7.4a4.1 4.1 0 0 1-3-1.35A4.1 4.1 0 0 1 16.5 3V2Z" />
    </svg>
  );
}

function InstagramMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function YoutubeMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden="true"
    >
      <path d="M21.6 7.2a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.84.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.84-.43a2.5 2.5 0 0 0 1.76-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z" />
    </svg>
  );
}

function ThreadsMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M19.2 7.9C18.2 4.7 15.7 3 12.1 3 7.2 3 4 6.4 4 12s3.2 9 8.1 9" />
      <path d="M12.1 21c3.4 0 5.6-1.7 5.6-4.1 0-2.4-2-3.9-5.1-3.9-2 0-3.4.9-3.4 2.3 0 1.3 1.1 2.1 2.7 2.1 2.2 0 3.4-1.7 3.4-4.6 0-2.6-1.4-4.2-3.5-4.2-1.3 0-2.4.5-3 1.5" />
    </svg>
  );
}

function ZaloMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.4c-5 0-9 3.3-9 7.4 0 2.4 1.4 4.5 3.5 5.8-.2 1.1-.7 2.2-1.5 3.1-.3.4 0 .9.5.8 2-.4 3.5-1.2 4.5-2 .7.1 1.3.2 2 .2 5 0 9-3.3 9-7.9s-4-7.4-9-7.4Z" />
      <path d="M9.3 8.4h5.4l-5.4 5.9h5.6" />
    </svg>
  );
}

function ShopeeMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8.4 8V6.9a3.6 3.6 0 0 1 7.2 0V8" />
      <path d="M4.4 8h15.2l-.9 11.8a1.5 1.5 0 0 1-1.5 1.4H6.8a1.5 1.5 0 0 1-1.5-1.4L4.4 8Z" />
      <path d="M14.1 12.7c-.5-.6-1.3-1-2.2-1-1.2 0-2 .7-2 1.6 0 2.1 4.4 1.4 4.4 3.6 0 1-1 1.8-2.3 1.8-1 0-1.9-.4-2.4-1" />
    </svg>
  );
}

function LazadaMark({ className }: ChannelMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.2 20.2 8v8L12 20.8 3.8 16V8L12 3.2Z" />
      {/* Filled, and big enough to read as a heart: at 24px an outlined one of
          this size collapsed into a blob in the running app. */}
      <path
        d="M12 17.4c-.35 0-.65-.13-.9-.35C8.75 15 7.4 13.7 7.4 12.05c0-1.4 1.1-2.5 2.5-2.5.83 0 1.57.4 2.1 1.02.53-.62 1.27-1.02 2.1-1.02 1.4 0 2.5 1.1 2.5 2.5 0 1.65-1.35 2.95-3.7 5-.25.22-.55.35-.9.35Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

const MARK_COMPONENTS: Record<ChannelMarkId, (props: ChannelMarkProps) => ReactElement> = {
  facebook: FacebookMark,
  tiktok: TiktokMark,
  instagram: InstagramMark,
  youtube: YoutubeMark,
  threads: ThreadsMark,
  zalo_oa: ZaloMark,
  shopee: ShopeeMark,
  lazada: LazadaMark,
};

/** Vietnamese label of each channel — for a caller that shows a mark alone. */
export const CHANNEL_MARK_LABELS: Record<ChannelMarkId, string> = {
  facebook: "Facebook",
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  threads: "Threads",
  zalo_oa: "Zalo OA",
  shopee: "Shopee",
  lazada: "Lazada",
};

/**
 * Somebody else's colour, not a theme role. Read the header before using it.
 * Never as a background for text, never as a border, never as a status colour.
 */
export const CHANNEL_BRAND_COLOR: Record<ChannelMarkId, string> = {
  facebook: "#1877F2",
  tiktok: "#010101",
  instagram: "#E1306C",
  youtube: "#FF0000",
  threads: "#101010",
  zalo_oa: "#0068FF",
  shopee: "#EE4D2D",
  lazada: "#0F146D",
};

export function isChannelMarkId(value: unknown): value is ChannelMarkId {
  return typeof value === "string" && (CHANNEL_MARK_IDS as readonly string[]).includes(value);
}

/**
 * The mark for a channel id, or `null` when the id is unknown.
 *
 * `null` rather than a throw or a silent blank: an unknown id is a bug in a
 * table of decoration, and taking a screen down for it would be worse than the
 * bug. The CALLER logs it — it is the one that knows which table was wrong.
 */
export function channelMark(id: string): ((props: ChannelMarkProps) => ReactElement) | null {
  return isChannelMarkId(id) ? MARK_COMPONENTS[id] : null;
}
