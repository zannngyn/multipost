"use client";

import { useId, useMemo, useState } from "react";

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
import {
  MAX_SHARED_WORD_RUN,
  findDuplicateCaptions,
} from "@/ui/components/compose/caption-duplicate";
import { describeFanOut } from "@/ui/components/compose/caption-fanout";
import { avatarToneStyle, channelInitials } from "@/ui/components/compose/channel-picker";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Select } from "@/ui/components/ui/select";
import { useCaptionFanOut, type CaptionFanOutStatus } from "@/ui/hooks/useCaptionFanOut";
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
  onOpenPicker,
  readOnlyReason,
}: {
  wizard: ComposeWizard;
  publish: PublishForm;
  /** Which channel tab is open; null = the shared caption. */
  activeChannelId: string | null;
  onActiveChannelChange: (channelId: string | null) => void;
  /** Opens the channel modal — the empty state's own way out. */
  onOpenPicker: () => void;
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
  const { selectedIds, captionSources } = publish;

  /**
   * "Viết caption cho N trang" — one press, one call per Page, each landing on
   * its own tab. Declared before the early return below, as every hook must be.
   */
  const fanOut = useCaptionFanOut({
    content: composed?.content ?? null,
    tone: wizard.tone,
    onText: publish.setCaptionOverride,
  });

  /**
   * D1, as an early warning: which tabs currently repeat another tab.
   *
   * Recomputed when the TEXTS change, not on every render — and deliberately
   * not only after a fan-out: an operator who edits two captions into agreement
   * by hand has the same problem, and a warning that only appears after the AI
   * ran would be a lie by omission.
   */
  const duplicateKey = selectedIds
    .map((channelId) => `${channelId}\u0000${resolveCaption(captionSources, channelId)}`)
    .join("\u0001");
  const duplicates = useMemo(
    () =>
      publish.shareCaption
        ? {}
        : findDuplicateCaptions(
            selectedIds.map((channelId) => ({
              channelId,
              text: resolveCaption(captionSources, channelId),
            })),
          ),
    // `duplicateKey` IS the dependency: it changes exactly when a caption does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [duplicateKey, publish.shareCaption],
  );

  if (!composed) return null;

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

  /** Per-Page mode with something to write for: the one-press fan-out. */
  const canFanOut = !publish.shareCaption && selectedIds.length > 0;
  const failedCount = selectedIds.filter(
    (channelId) => fanOut.statuses[channelId] === "error",
  ).length;
  const progress = describeFanOut({
    isRunning: fanOut.isRunning,
    done: fanOut.done,
    total: fanOut.total,
    failed: failedCount,
  });
  const busy = captions.isPending || fanOut.isRunning;

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
        <p className="rounded-xl bg-[var(--muted)] px-3.5 py-2.5 text-xs leading-relaxed">
          {readOnlyReason}
        </p>
      ) : null}

      {wizard.toneDropped ? (
        <p
          role="status"
          className="rounded-xl bg-[var(--muted)] px-3.5 py-2.5 text-xs leading-relaxed"
        >
          Tông giọng chưa sẵn sàng trên máy chủ — caption vừa rồi được viết theo tông mặc định.
        </p>
      ) : null}

      {/* --- Dòng đầu: công tắc caption riêng (PM, 21/08/2026) ---------- */}
      <PerChannelSwitch
        id={`${fieldId}-per-channel`}
        /** The model still stores "dùng chung"; the switch shows its opposite,
            because "caption riêng từng kênh" is the thing an operator turns ON
            (and the default, per brief §7.2 + validator D1). */
        perChannel={!publish.shareCaption}
        disabled={publish.isPending}
        channelCount={selectedIds.length}
        onChange={(nextPerChannel) => {
          if (nextPerChannel) {
            publish.setShareCaption(false, { seedFrom: selectedIds });
            onActiveChannelChange(selectedIds[0] ?? null);
            return;
          }
          const losing = overridesThatDifferFromBase(captionSources, selectedIds);
          if (losing.length > 0) {
            setConfirmShare(losing);
            return;
          }
          publish.setShareCaption(true);
          onActiveChannelChange(null);
        }}
      />

      {confirmShare ? (
        <div
          role="alertdialog"
          aria-label="Xác nhận dùng chung caption"
          className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--warning)]/15 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--warning-foreground)]"
        >
          <span>
            {confirmShare.length} kênh đang có caption riêng ({confirmShare.map(nameOf).join(", ")}
            ). Tắt “caption riêng” sẽ bỏ các bản riêng đó.
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
            className="focus-visible:ring-ring cursor-pointer rounded-md bg-primary text-primary-foreground px-3 py-1 font-semibold outline-none focus-visible:ring-3"
          >
            Bỏ và dùng chung
          </button>
        </div>
      ) : null}

      {selectedIds.length === 0 ? (
        <NoChannelYet onOpenPicker={onOpenPicker} />
      ) : (
      <section
        aria-labelledby={`${fieldId}-heading`}
        className="flex flex-col rounded-lg bg-[var(--muted)] shadow-[inset_0_0_0_1px_var(--border)]"
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
                      ? "bg-[var(--accent)] font-semibold shadow-[inset_0_0_0_1.5px_var(--primary)]"
                      : "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--border)]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    style={avatarToneStyle(name)}
                    className="flex size-7 items-center justify-center rounded-full text-[10px] font-semibold"
                  >
                    {channelInitials(name)}
                  </span>
                  <span className="max-w-35 truncate">{name}</span>
                  <TabState
                    state={state}
                    running={fanOut.statuses[channelId]}
                    duplicate={Boolean(duplicates[channelId])}
                  />
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

          {/* The pill follows whichever mechanism last touched THIS tab: the
              single "Viết lại" call, or this tab's slot in the fan-out. */}
          <AiStatePill
            pending={
              (captions.isPending && isThisTarget) ||
              (activeId ? fanOut.statuses[activeId] === "pending" : false)
            }
            generated={
              (Boolean(generated) && isThisTarget && captions.isSuccess) ||
              (activeId ? fanOut.statuses[activeId] === "done" : false)
            }
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
            className="h-8.5 w-auto rounded-lg border-0 bg-[var(--card)] px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <optgroup label="Mẫu prompt">
              {CAPTION_TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {CAPTION_TONE_LABELS[tone]}
                </option>
              ))}
            </optgroup>
          </Select>

          {/* Per-Page mode: ONE press writes every ticked Page, each call
              landing on its own tab. The single-tab "Viết lại" stays beside it
              for fixing one Page without spending N calls. */}
          {canFanOut && selectedIds.length > 1 ? (
            <button
              type="button"
              onClick={() => fanOut.run(selectedIds)}
              disabled={busy || Boolean(readOnlyReason)}
              title={readOnlyReason ?? undefined}
              className="focus-visible:ring-ring h-8.5 cursor-pointer rounded-lg bg-primary text-primary-foreground px-3.5 text-[13px] font-semibold outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {fanOut.isRunning
                ? `Đang viết ${fanOut.done}/${fanOut.total}…`
                : `Viết caption cho ${selectedIds.length} trang`}
            </button>
          ) : null}

          <button
            type="button"
            onClick={generate}
            disabled={busy || Boolean(readOnlyReason)}
            title={readOnlyReason ?? undefined}
            className="focus-visible:ring-ring h-8.5 cursor-pointer rounded-md px-1.5 text-sm font-semibold text-[var(--primary)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {captions.isPending && isThisTarget
              ? "Đang viết…"
              : value.trim().length > 0
                ? canFanOut && selectedIds.length > 1
                  ? "Viết lại trang này"
                  : "Viết lại"
                : "Nhờ AI viết"}
          </button>
        </div>

        {/* Progress of the fan-out, announced without stealing focus. */}
        {progress ? (
          <p
            role="status"
            aria-live="polite"
            className="mx-4 mb-3 rounded-xl bg-[var(--muted)] px-3.5 py-2 text-xs leading-relaxed"
          >
            {progress}
          </p>
        ) : null}

        {/* The failure of THIS tab's own fan-out call, with its own retry.
            One channel failing never stops the others (business rule 6). */}
        {activeId && fanOut.statuses[activeId] === "error" ? (
          <p
            role="alert"
            className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3.5 py-2.5 text-[13px] text-[var(--destructive)]"
          >
            <span>
              {nameOf(activeId)}: {fanOut.errors[activeId]}
            </span>
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className="focus-visible:ring-ring cursor-pointer rounded-md px-2 py-0.5 font-semibold underline underline-offset-2 outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Viết lại trang này
            </button>
          </p>
        ) : null}

        {/* D1, early: the server refuses two channels sharing more than eight
            consecutive words. Saying it here means the fix is one press away
            instead of arriving as a blocked post job. */}
        {activeId && duplicates[activeId] ? (
          <p className="mx-4 mb-3 rounded-xl bg-[var(--warning)]/15 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--warning-foreground)]">
            Caption này trùng {MAX_SHARED_WORD_RUN + 1} từ liên tiếp với{" "}
            {nameOf(duplicates[activeId].otherChannelId)}: “{duplicates[activeId].run}”. Bấm “Viết
            lại trang này” để có bản khác — máy chủ sẽ chặn bài trùng khi đăng.
          </p>
        ) : null}

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

      )}

      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        {publish.shareCaption
          ? "Mọi kênh đã chọn sẽ nhận đúng caption này. Bật “caption riêng” khi đăng nhiều Fanpage — nội dung trùng hệt nhau dễ bị nền tảng coi là spam."
          : selectedIds.length > 1
            ? "Mỗi kênh một caption riêng. Bấm “Viết caption cho N trang” để AI viết cho tất cả, hoặc mở từng tab để sửa tay."
            : selectedIds.length === 1
              ? "Chọn thêm kênh để mỗi Fanpage có một caption riêng."
              : ""}
      </p>
    </div>
  );
}

/** Soft limit — going over is allowed, it is only counted out loud. */
const HASHTAG_BUDGET = 10;

/**
 * "Caption riêng từng kênh" — the FIRST thing in the caption block (PM,
 * 21/08/2026), because it decides what everything under it means.
 *
 * The switch is the inverse of the stored `shareCaption`: an operator turns ON
 * "riêng", and the model records "not shared". Presenting it the other way
 * round (a "dùng chung" switch that is off by default) made the default look
 * like an omission instead of the deliberate choice it is — brief §7.2 and
 * validator D1 both want captions to differ.
 */
function PerChannelSwitch({
  id,
  perChannel,
  channelCount,
  disabled,
  onChange,
}: {
  id: string;
  perChannel: boolean;
  channelCount: number;
  disabled?: boolean;
  onChange: (perChannel: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-center gap-2.5 rounded-md bg-[var(--card)] px-3.5 py-3 text-sm shadow-[inset_0_0_0_1px_var(--border)]",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={perChannel}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring/50 peer-checked:[&>span]:translate-x-4 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-focus-visible:ring-3"
      >
        <span className="bg-card size-4 rounded-full shadow-sm transition-transform" />
      </span>
      <span className="font-medium">Caption riêng từng kênh</span>
      <span className="flex-1" />
      <span className="text-xs text-[var(--muted-foreground)]">
        {perChannel
          ? channelCount > 1
            ? `${channelCount} trang, mỗi trang một bản`
            : "mỗi trang một bản"
          : "một caption cho mọi trang"}
      </span>
    </label>
  );
}

/**
 * Nothing to write for yet. NOT a disabled box: it says what to do next and
 * carries the way to do it (core-feedback-states — empty states have a CTA).
 */
function NoChannelYet({ onOpenPicker }: { onOpenPicker: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg bg-[var(--muted)] px-4 py-8 shadow-[inset_0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium">Chọn kênh đăng trước để viết caption</p>
      <p className="max-w-110 text-xs leading-relaxed text-[var(--muted-foreground)]">
        Mỗi Fanpage cần một caption riêng, nên hệ thống hỏi bạn đăng lên đâu trước rồi mới viết.
      </p>
      <button
        type="button"
        onClick={onOpenPicker}
        className="focus-visible:ring-ring mt-1 h-9.5 cursor-pointer rounded-lg bg-[var(--card)] px-4 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3"
      >
        Chọn kênh đăng
      </button>
    </div>
  );
}

/**
 * The dot on a channel tab. Text carries it too: colour is never alone
 * (core-accessibility §5).
 *
 * Order is deliberate — what is happening RIGHT NOW outranks what the caption
 * is: a tab being written must not read as "đã có caption riêng" for the two
 * seconds before its text lands.
 */
function TabState({
  state,
  running,
  duplicate,
}: {
  state: ChannelCaptionState;
  /** This tab's fan-out call, when one is in flight or has just failed. */
  running?: CaptionFanOutStatus;
  /** True when this caption repeats another channel's (D1). */
  duplicate?: boolean;
}) {
  if (running === "pending") {
    return (
      <>
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--primary)] motion-safe:animate-pulse"
        />
        <span className="sr-only">— đang viết</span>
      </>
    );
  }
  if (running === "error") {
    return (
      <>
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--destructive)]" />
        <span className="sr-only">— viết lỗi, cần thử lại</span>
      </>
    );
  }
  if (duplicate) {
    return (
      <>
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--warning)]" />
        <span className="sr-only">— trùng caption với kênh khác</span>
      </>
    );
  }
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
        <div className="flex flex-col gap-2.5 rounded-md bg-[var(--card)] p-4 shadow-[inset_0_0_0_1px_var(--border)]">
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
            className="focus-visible:ring-ring border-0 bg-transparent text-sm leading-6 text-[var(--primary)] outline-none placeholder:text-[var(--muted-foreground)] focus-visible:ring-3 focus-visible:ring-offset-2"
          />
        </div>
      </div>

      {/* --- Tier 3: tag suggestions (template 100–109) ----------------- */}
      <div
        id={`${idPrefix}-meta`}
        className="flex flex-col gap-2.5 px-4 pt-3 pb-4 shadow-[inset_0_1px_0_var(--border)]"
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
                  "focus-visible:ring-ring h-8 cursor-pointer rounded-md px-3 text-[13px] text-[var(--muted-foreground)] outline-none focus-visible:ring-3",
                  "shadow-[inset_0_0_0_1px_var(--input)] hover:bg-[var(--card)]",
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
          ? "bg-success/20 text-success-foreground"
          : "bg-[var(--muted)] text-[var(--muted-foreground)]",
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
