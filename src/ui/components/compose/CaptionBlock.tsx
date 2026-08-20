"use client";

import { useId, useState } from "react";

import { CAPTION_TONES, CAPTION_TONE_LABELS, type CaptionTone } from "@/shared/caption-tone";
import { cn } from "@/shared/utils";
import {
  addHashtag,
  countHashtags,
  joinCaptionTags,
  splitCaptionTags,
} from "@/ui/components/compose/caption-text";
import {
  SHARED_TARGET,
  activeCaptionChannel,
  channelCaptionState,
  overridesThatDifferFromBase,
  resolveCaption,
  sameTarget,
  type CaptionTarget,
  type ChannelCaptionState,
} from "@/ui/components/compose/caption-targets";
import { avatarToneVar, channelInitials } from "@/ui/components/compose/channel-picker";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Select } from "@/ui/components/ui/select";
import { useChannels } from "@/ui/hooks/useChannels";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import type { PublishForm } from "@/ui/hooks/usePublishForm";
import { COMPOSE_CHANNELS, type ComposeResponse } from "@/ui/schemas/compose.schema";

/**
 * The caption block of the ComposeFocus design — template lines 82–109, three
 * tiers inside one sunken well:
 *
 *   header  "Caption" · pill trạng thái AI · dropdown tông · "Viết lại"   (83–95)
 *   body    the caption on a raised card, hashtags on their own blue line (96–99)
 *   footer  "GỢI Ý THẺ" · đã dùng x/10 · chips "+ #tag"                  (100–109)
 *
 * ONE CAPTION PER CHANNEL (brief §7.2). A post that goes to five Fanpages needs
 * five texts, not one repeated five times — the platform reads identical posts
 * as spam and the server's validator (D1: trùng > 8 từ liên tiếp) refuses them.
 * So above the header sits a row of channel tabs, one per ticked Page, each
 * with its own text, its own AI state and its own "Viết lại". "Dùng chung một
 * caption" is the shortcut out of that, and it lives here rather than beside the
 * channel list because this is where its effect is visible.
 *
 * What each mode publishes (`caption-targets.ts` owns the rule, and
 * `usePublishForm` builds the payload from the SAME function):
 *   dùng chung  → the one caption, copied to every ticked channel;
 *   per-channel → each channel's own text, falling back to the shared caption
 *                 for a channel nobody has written for yet. The fallback is why
 *                 a post can never go out captionless by accident, and the tab
 *                 says "đang dùng caption chung" so it is never a surprise.
 *
 * The body and the tag line are two fields over ONE string (`caption-text.ts`).
 * Splitting them is a view, not a second value — the draft, the preview and the
 * publish payload all keep reading the single caption they always did.
 *
 * Business rule 2 made visible: the four whitelisted columns are what the writer
 * was given, and this block shows no stock, price or production note. The
 * operator warnings live OUTSIDE it, above, where copying the caption cannot
 * pick them up.
 */
export function CaptionBlock({
  wizard,
  publish,
  activeChannelId,
  onActiveChannelChange,
  readOnlyReason,
}: {
  wizard: ComposeWizard;
  publish: PublishForm;
  /** Which channel tab is open; null = the shared caption. */
  activeChannelId: string | null;
  onActiveChannelChange: (channelId: string | null) => void;
  /**
   * Support mode (M3.3): generating a caption spends money and writes an
   * `ai_generation` row, so it is a WRITE and the server answers 403. Editing
   * the text by hand stays available — it touches nothing until "Đăng luôn".
   */
  readOnlyReason?: string | null;
}) {
  const fieldId = useId();
  const channels = useChannels();
  const { captions, composed } = wizard;
  const [confirmShare, setConfirmShare] = useState<string[] | null>(null);

  if (!composed) return null;

  const { selectedIds, captionSources } = publish;
  /**
   * NO channel count in this decision (see `activeCaptionChannel`): the editor
   * is on whichever channel the payload will be built for, whether that is one
   * channel or five. The tab STRIP is hidden for a single channel because one
   * tab is noise — but the value below never depends on that.
   */
  const activeId = activeCaptionChannel({
    shareCaption: publish.shareCaption,
    selectedIds,
    requested: activeChannelId,
  });
  const showTabs = activeId !== null && selectedIds.length > 1;
  const target: CaptionTarget = activeId
    ? { kind: "channel", channelId: activeId }
    : SHARED_TARGET;

  const nameOf = (channelId: string): string => {
    const found = channels.data?.channels.find((item) => item.channelId === channelId);
    const name = found?.name?.trim();
    return name && name.length > 0 ? name : channelId;
  };

  // The AI answers for the PLATFORM channel ("facebook"), never for a Fanpage
  // id — the request carries the product, not the Page. Its result therefore
  // belongs to whichever tab asked for it.
  const answer = captions.data;
  const generated = answer?.generated.find(
    (item) => item.channelId === COMPOSE_CHANNELS[0].id,
  );
  const failed = answer?.failed.find((item) => item.channelId === COMPOSE_CHANNELS[0].id);
  const askedFor = captions.variables;
  const isThisTarget = sameTarget(askedFor, target);

  // THE invariant: this is the same call `usePublishForm.captionFor` makes when
  // it builds `captionByChannel`. The box shows the string that gets published.
  const value = activeId ? resolveCaption(captionSources, activeId) : captionSources.base;

  function writeCaption(next: string) {
    if (activeId) {
      publish.setCaptionOverride(activeId, next);
      return;
    }
    wizard.form.setValue(`captions.${COMPOSE_CHANNELS[0].id}`, next, { shouldDirty: true });
  }

  function generate() {
    captions.mutate(target, {
      onSuccess: (result) => {
        if (target.kind !== "channel") return;
        const text = result.generated.find(
          (item) => item.channelId === COMPOSE_CHANNELS[0].id,
        )?.text;
        // A channel whose generation came back empty keeps whatever it had —
        // and `failed` below is what tells the operator why.
        if (text) publish.setCaptionOverride(target.channelId, text);
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {readOnlyReason ? (
        <p className="rounded-xl bg-[var(--compose-track)] px-3.5 py-2.5 text-xs leading-relaxed">
          {readOnlyReason}
        </p>
      ) : null}

      {wizard.toneDropped ? (
        <p
          role="status"
          className="rounded-xl bg-[var(--compose-track)] px-3.5 py-2.5 text-xs leading-relaxed"
        >
          Tông giọng chưa sẵn sàng trên máy chủ — caption vừa rồi được viết theo tông mặc định.
        </p>
      ) : null}

      <section
        aria-labelledby={`${fieldId}-heading`}
        className="flex flex-col rounded-[var(--compose-radius-block)] bg-[var(--compose-well)] shadow-[inset_0_0_0_1px_var(--compose-hairline)]"
      >
        {/* --- Channel tabs: one caption per Page ------------------------- */}
        {showTabs ? (
          <div
            role="tablist"
            aria-label="Caption theo từng kênh"
            className="flex flex-wrap items-center gap-2 px-4 pt-3.5"
          >
            {selectedIds.map((channelId) => {
              const name = nameOf(channelId);
              const state = channelCaptionState(captionSources, channelId);
              const isActive = channelId === activeId;

              return (
                <button
                  key={channelId}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onActiveChannelChange(channelId)}
                  className={cn(
                    "focus-visible:ring-ring flex h-9 cursor-pointer items-center gap-2 rounded-full py-0 pr-3 pl-1 text-[13px] transition-colors outline-none focus-visible:ring-3",
                    isActive
                      ? "bg-[var(--compose-chip-on)] font-semibold shadow-[inset_0_0_0_1.5px_var(--compose-chip-ring)]"
                      : "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--compose-hairline)]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    style={{ background: avatarToneVar(name) }}
                    className="flex size-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  >
                    {channelInitials(name)}
                  </span>
                  <span className="max-w-35 truncate">{name}</span>
                  <TabState state={state} />
                </button>
              );
            })}
          </div>
        ) : null}

        {/* --- Tier 1: header (template 83–95) --------------------------- */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
          <h3 id={`${fieldId}-heading`} className="text-sm font-semibold">
            Caption
            {activeId ? (
              <span className="text-[var(--muted-foreground)]"> · {nameOf(activeId)}</span>
            ) : null}
          </h3>

          <AiStatePill
            pending={captions.isPending && isThisTarget}
            generated={Boolean(generated) && isThisTarget && captions.isSuccess}
            hasText={value.trim().length > 0}
          />

          <span className="flex-1" />

          <label htmlFor={`${fieldId}-tone`} className="sr-only">
            Tông giọng cho caption
          </label>
          {/* Native <select>: a short fixed list, and the browser control is
              keyboard- and screen-reader-correct on every device with no bundle
              cost. `optgroup` carries the design's "MẪU PROMPT" heading. */}
          <Select
            id={`${fieldId}-tone`}
            value={wizard.tone}
            disabled={captions.isPending || Boolean(readOnlyReason)}
            onChange={(event) => wizard.setTone(event.target.value as CaptionTone)}
            className="h-8.5 w-auto rounded-[10px] border-0 bg-[var(--card)] px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <optgroup label="Mẫu prompt">
              {CAPTION_TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {CAPTION_TONE_LABELS[tone]}
                </option>
              ))}
            </optgroup>
          </Select>

          <button
            type="button"
            onClick={generate}
            disabled={captions.isPending || Boolean(readOnlyReason)}
            title={readOnlyReason ?? undefined}
            className="focus-visible:ring-ring h-8.5 cursor-pointer rounded-md px-1.5 text-sm font-semibold text-[var(--primary)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {captions.isPending && isThisTarget
              ? "Đang viết…"
              : value.trim().length > 0
                ? "Viết lại"
                : "Nhờ AI viết"}
          </button>
        </div>

        {/* Per-tab failure: the request that broke, or the channel the AI
            refused. Either way it belongs to THIS tab and nowhere else — one
            channel failing must not take the others down (business rule 6). */}
        {isThisTarget && captions.isError ? (
          <div className="px-4 pb-3">
            <ApiErrorNotice error={captions.error} onRetry={generate} />
          </div>
        ) : null}

        {isThisTarget && failed ? (
          <p
            role="alert"
            className="mx-4 mb-3 rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3.5 py-2.5 text-[13px] text-[var(--destructive)]"
          >
            AI chưa viết được caption cho{" "}
            {activeId ? nameOf(activeId) : "kênh này"}: {failed.reason}{" "}
            <span className="font-mono text-xs">({failed.code})</span> — bấm “Viết lại” hoặc tự
            nhập bên dưới.
          </p>
        ) : null}

        {activeId && channelCaptionState(captionSources, activeId) === "inherited" ? (
          <p className="mx-4 mb-3 rounded-xl bg-[var(--warning)]/15 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--warning-foreground)]">
            Kênh này đang dùng chung caption với các kênh khác. Sửa hoặc bấm “Viết lại” để có bản
            riêng — nhiều Fanpage đăng y hệt nhau dễ bị coi là spam.
          </p>
        ) : null}

        <CaptionFields
          idPrefix={`${fieldId}-${activeId ?? "shared"}`}
          label={activeId ? nameOf(activeId) : "Facebook"}
          value={value}
          onChange={writeCaption}
          content={composed.content}
          hashtagsFromAi={isThisTarget ? generated?.hashtags : undefined}
          provider={isThisTarget && captions.isSuccess ? generated : undefined}
        />
      </section>

      {/* --- "Dùng chung một caption" ----------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`${fieldId}-share`}
          className="flex cursor-pointer items-center gap-2.5 text-sm"
        >
          <input
            id={`${fieldId}-share`}
            type="checkbox"
            className="peer sr-only"
            checked={publish.shareCaption}
            disabled={publish.isPending}
            onChange={(event) => {
              if (!event.target.checked) {
                // chung → riêng: every ticked channel starts from what is on
                // screen instead of an empty box.
                publish.setShareCaption(false, { seedFrom: selectedIds });
                onActiveChannelChange(selectedIds[0] ?? null);
                return;
              }
              // riêng → chung: ask first, but only when it would actually
              // destroy something.
              const losing = overridesThatDifferFromBase(captionSources, selectedIds);
              if (losing.length > 0) {
                setConfirmShare(losing);
                return;
              }
              publish.setShareCaption(true);
              onActiveChannelChange(null);
            }}
          />
          <span
            aria-hidden="true"
            className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring/50 peer-checked:[&>span]:translate-x-4 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-focus-visible:ring-3"
          >
            <span className="bg-card size-4 rounded-full shadow-sm transition-transform" />
          </span>
          <span>Dùng chung một caption cho mọi kênh</span>
        </label>

        {confirmShare ? (
          <div
            role="alertdialog"
            aria-label="Xác nhận dùng chung caption"
            className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--warning)]/15 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--warning-foreground)]"
          >
            <span>
              {confirmShare.length} kênh đang có caption riêng ({confirmShare.map(nameOf).join(", ")}
              ). Dùng chung sẽ bỏ các bản riêng đó.
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setConfirmShare(null)}
              className="focus-visible:ring-ring cursor-pointer rounded-md px-2 py-1 font-semibold outline-none focus-visible:ring-3"
            >
              Giữ bản riêng
            </button>
            <button
              type="button"
              onClick={() => {
                publish.setShareCaption(true);
                onActiveChannelChange(null);
                setConfirmShare(null);
              }}
              className="focus-visible:ring-ring cursor-pointer rounded-md bg-[var(--compose-ink)] px-3 py-1 font-semibold text-[var(--card)] outline-none focus-visible:ring-3"
            >
              Bỏ và dùng chung
            </button>
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          {publish.shareCaption
            ? "Mọi kênh đã chọn sẽ nhận đúng caption này. Nên tắt khi đăng nhiều Fanpage — nội dung trùng hệt nhau dễ bị nền tảng coi là spam."
            : selectedIds.length > 1
              ? "Mỗi kênh một caption riêng. Bấm vào tab kênh ở trên để sửa từng bản."
              : "Chọn thêm kênh để soạn caption riêng cho từng Fanpage."}
        </p>
      </div>
    </div>
  );
}

/** Soft limit — going over is allowed, it is only counted out loud. */
const HASHTAG_BUDGET = 10;

/** The dot on a channel tab. Text carries it too: colour is never alone. */
function TabState({ state }: { state: ChannelCaptionState }) {
  if (state === "own") {
    return (
      <>
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--success)]" />
        <span className="sr-only">— đã có caption riêng</span>
      </>
    );
  }
  if (state === "inherited") {
    return (
      <>
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--warning)]" />
        <span className="sr-only">— đang dùng caption chung</span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--destructive)]" />
      <span className="sr-only">— chưa có caption</span>
    </>
  );
}

/**
 * Tiers 2 and 3 of the block: the caption itself, and the tag suggestions.
 *
 * Presentational — it holds no idea of WHICH caption it is editing. That is the
 * caller's decision, which is what lets one component serve the shared caption
 * and every per-channel tab without either of them forking it.
 */
function CaptionFields({
  idPrefix,
  label,
  value,
  onChange,
  content,
  hashtagsFromAi,
  provider,
}: {
  idPrefix: string;
  /** Named in the placeholder and the sr-only label, so tabs stay tellable apart. */
  label: string;
  value: string;
  onChange: (next: string) => void;
  content: ComposeResponse["content"];
  hashtagsFromAi?: readonly string[];
  provider?: { provider: string; model: string };
}) {
  const used = countHashtags(value);

  /**
   * The two fields are LOCAL while the operator is typing, and only re-derived
   * from the caption when it changes for another reason (the AI wrote it, a
   * draft was restored, another tab was opened).
   *
   * Splitting on every keystroke instead would move the text out from under the
   * cursor: the moment "#a" is typed at the end of the body it stops being body
   * and becomes the tag line, and the caret jumps to the other field mid-word.
   * This is React's documented "adjust state during render" pattern — no effect,
   * no extra render pass.
   */
  const [fields, setFields] = useState(() => splitCaptionTags(value));
  const [lastWritten, setLastWritten] = useState(value);
  if (value !== lastWritten) {
    setLastWritten(value);
    setFields(splitCaptionTags(value));
  }
  const { body, tags } = fields;

  function write(nextBody: string, nextTags: string) {
    const next = joinCaptionTags(nextBody, nextTags);
    setFields({ body: nextBody, tags: nextTags });
    setLastWritten(next);
    onChange(next);
  }

  const suggestions = suggestHashtags(content, hashtagsFromAi).filter(
    (tag) => !tags.toLowerCase().split(/\s+/).includes(tag.toLowerCase()),
  );

  return (
    <>
      {/* --- Tier 2: the post itself (template 96–99) ------------------- */}
      <div className="px-4 pb-3.5">
        <div className="flex flex-col gap-2.5 rounded-[var(--compose-radius-tile)] bg-[var(--compose-raised)] p-4 shadow-[inset_0_0_0_1px_var(--compose-hairline)]">
          <label htmlFor={idPrefix} className="sr-only">
            Nội dung caption cho {label}
          </label>
          <textarea
            id={idPrefix}
            value={body}
            rows={5}
            onChange={(event) => write(event.target.value, tags)}
            aria-describedby={`${idPrefix}-meta`}
            placeholder={`Nhập caption sẽ đăng lên ${label}… hoặc bấm “Nhờ AI viết”.`}
            className="focus-visible:ring-ring resize-none border-0 bg-transparent text-sm leading-6 outline-none placeholder:text-[var(--muted-foreground)] focus-visible:ring-3 focus-visible:ring-offset-2"
          />

          <label htmlFor={`${idPrefix}-tags`} className="sr-only">
            Dòng hashtag của caption cho {label}
          </label>
          <input
            id={`${idPrefix}-tags`}
            value={tags}
            onChange={(event) => write(body, event.target.value)}
            placeholder="#hashtag của bài"
            spellCheck={false}
            className="focus-visible:ring-ring border-0 bg-transparent text-sm leading-6 text-[var(--compose-link)] outline-none placeholder:text-[var(--muted-foreground)] focus-visible:ring-3 focus-visible:ring-offset-2"
          />
        </div>
      </div>

      {/* --- Tier 3: tag suggestions (template 100–109) ----------------- */}
      <div
        id={`${idPrefix}-meta`}
        className="flex flex-col gap-2.5 px-4 pt-3 pb-4 shadow-[inset_0_1px_0_var(--compose-hairline)]"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--foreground-subtle)] uppercase">
            Gợi ý thẻ
          </span>
          <span className="text-xs text-[var(--muted-foreground)]">
            đã dùng {used} / {HASHTAG_BUDGET}
          </span>
          <span className="flex-1" />
          <span className="font-mono text-xs text-[var(--foreground-subtle)]">
            {value.trim().length} ký tự
          </span>
        </div>

        {suggestions.length > 0 ? (
          <div role="group" aria-label={`Thêm hashtag cho ${label}`} className="flex flex-wrap gap-2">
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => write(body, addHashtag(tags, tag))}
                className={cn(
                  "focus-visible:ring-ring h-8 cursor-pointer rounded-[9px] px-3 text-[13px] text-[var(--compose-text-2)] outline-none focus-visible:ring-3",
                  "shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)] hover:bg-[var(--card)]",
                )}
              >
                + {tag}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--muted-foreground)]">
            Không còn gợi ý nào chưa dùng — bạn vẫn gõ thêm thẻ trực tiếp vào dòng hashtag được.
          </p>
        )}

        {used > HASHTAG_BUDGET ? (
          <p role="status" className="text-xs leading-relaxed text-[var(--warning-foreground)]">
            Caption đang có {used} thẻ. Quá nhiều thẻ dễ bị coi là spam — vẫn đăng được nếu bạn
            muốn.
          </p>
        ) : null}

        {provider ? (
          <p className="text-xs text-[var(--muted-foreground)]">
            Bản nháp gần nhất do {provider.provider}/{provider.model} viết. Nội dung trong ô là bản
            bạn duyệt.
          </p>
        ) : null}
      </div>
    </>
  );
}

/** The AI state pill of template line 85. */
function AiStatePill({
  pending,
  generated,
  hasText,
}: {
  pending: boolean;
  generated: boolean;
  hasText: boolean;
}) {
  const { text, tone } = describeAiState({ pending, generated, hasText });

  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-xs",
        tone === "ok"
          ? "bg-[var(--compose-ok-bg)] text-[var(--compose-ok-fg)]"
          : "bg-[var(--compose-track)] text-[var(--muted-foreground)]",
      )}
    >
      {text}
    </span>
  );
}

function describeAiState(state: {
  pending: boolean;
  generated: boolean;
  hasText: boolean;
}): { text: string; tone: "ok" | "neutral" } {
  if (state.pending) return { text: "AI đang viết…", tone: "neutral" };
  if (!state.hasText) return { text: "Chưa có nội dung", tone: "neutral" };
  if (state.generated) return { text: "AI đã viết · bạn duyệt", tone: "ok" };
  return { text: "Bạn tự viết", tone: "neutral" };
}

/**
 * Tags offered as one-click inserts: the AI's own suggestions when there are
 * any, otherwise derived from the SAME whitelisted fields the prompt was built
 * from (business rule 2) — never from stock, price or notes.
 */
function suggestHashtags(
  content: ComposeResponse["content"] | undefined,
  fromAi: readonly string[] | undefined,
): string[] {
  if (fromAi && fromAi.length > 0) return [...fromAi];
  if (!content) return [];

  return [content.code, content.name, content.category, content.season]
    .map((value) => toHashtag(value))
    .filter((tag): tag is string => tag !== null)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

/** "Váy xoè" -> "#vayxoe". Vietnamese marks are stripped, not transliterated. */
function toHashtag(value: string | null | undefined): string | null {
  if (!value) return null;
  const slug = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^0-9A-Za-z]/g, "");
  return slug.length > 0 ? `#${slug}` : null;
}
