"use client";

import { useCallback, useId, useRef } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { Textarea } from "@/ui/components/ui/textarea";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS, type ComposeResponse } from "@/ui/schemas/compose.schema";

/**
 * Step 2 — one caption per channel: generate with AI, edit by hand, or write it
 * from scratch. Nothing is auto-approved and nothing is auto-posted.
 *
 * Shaped like the approved design's caption card: a header that says whose text
 * this is and where it came from, the text itself on a raised surface, and the
 * hashtag suggestions along the bottom with a used/limit count. The live
 * Facebook preview is NOT in this file any more — it belongs to the wizard
 * frame, so it stays on screen on every step instead of appearing for one.
 *
 * Manual entry is a first-class path, not a fallback bolted on: Phase 1 runs
 * without an AI key on most machines, and an operator must still be able to
 * finish a post. The textarea is therefore always editable, whether or not the
 * AI answered.
 *
 * PLAIN TEXT, on purpose. The approved design draws a rich-text toolbar (bold,
 * headings, lists), but the Graph API takes a caption as plain text: bold marks
 * would either be silently dropped or posted as literal `**`. The toolbar here
 * only offers what survives the trip — characters that go into the string.
 *
 * Business rule 2: only the four whitelisted fields were sent to the model, and
 * nothing on this screen shows stock or price.
 */

const EMOJIS = ["💜", "✨", "🌸", "👗", "🔥", "📩"] as const;

/**
 * How many hashtags are worth having in one caption. A soft limit: going over
 * is allowed (the operator may know better), it is only counted out loud so
 * nobody ends up with a wall of tags without noticing.
 */
const HASHTAG_BUDGET = 10;

export function StepCaption({
  wizard,
  onPreviewChannel,
}: {
  wizard: ComposeWizard;
  /** Tells the frame which channel's caption the preview should show. */
  onPreviewChannel: (channelId: string) => void;
}) {
  const fieldId = useId();
  const { captions, composed } = wizard;

  if (!composed) return null;

  const failedByChannel = new Map(
    (captions.data?.failed ?? []).map((item) => [item.channelId, item]),
  );
  const generatedByChannel = new Map(
    (captions.data?.generated ?? []).map((item) => [item.channelId, item]),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {captions.isError ? (
        <ApiErrorNotice
          error={captions.error}
          onRetry={() => captions.mutate()}
          extraAction={
            <Button
              type="button"
              variant="outline"
              onClick={() => wizard.form.setFocus(`captions.${COMPOSE_CHANNELS[0].id}`)}
            >
              Tự nhập caption
            </Button>
          }
        />
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {captions.isPending
          ? "Đang tạo caption bằng AI"
          : captions.isSuccess
            ? "Đã tạo xong caption"
            : ""}
      </p>

      {COMPOSE_CHANNELS.map((channel) => (
        <CaptionEditor
          key={channel.id}
          idPrefix={`${fieldId}-${channel.id}`}
          channelId={channel.id}
          channelLabel={channel.label}
          wizard={wizard}
          failedReason={failedByChannel.get(channel.id)}
          generated={generatedByChannel.get(channel.id)}
          onFocus={() => onPreviewChannel(channel.id)}
        />
      ))}

      <div className="grid items-start gap-4 @3xl:grid-cols-[1.2fr_1fr]">
        <PromptFacts content={composed.content} />
        <section aria-labelledby="never-heading" className="bg-muted h-full rounded-2xl p-4">
          <div className="flex items-center gap-2.5 pb-3">
            <span aria-hidden="true" className="bg-foreground-subtle size-2 rounded-full" />
            <h3 id="never-heading" className="text-sm font-semibold">
              Không bao giờ vào caption
            </h3>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Giá, tồn kho và ghi chú sản xuất không được gửi cho AI. Nếu bạn tự gõ vào, hệ thống vẫn
            đăng đúng như bạn gõ.
          </p>
        </section>
      </div>
    </div>
  );
}

/** The four whitelisted columns, repeated here so the writer can see the source. */
function PromptFacts({ content }: { content: ComposeResponse["content"] }) {
  return (
    <section
      aria-labelledby="prompt-facts-heading"
      className="bg-card border-border h-full rounded-2xl border p-4"
    >
      <div className="flex items-center gap-2.5 pb-3">
        <span aria-hidden="true" className="bg-primary size-2 rounded-full" />
        <h3 id="prompt-facts-heading" className="text-sm font-semibold">
          Dữ liệu AI được dùng
        </h3>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm leading-relaxed">
        {(
          [
            ["Tên sản phẩm", content.name],
            ["Chủng loại", content.category],
            ["Mùa vụ", content.season],
            ["Mô tả", content.description],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value ? "font-medium" : "text-muted-foreground italic"}>
              {value && value.trim().length > 0 ? value : "(trống trên Sheet)"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CaptionEditor({
  idPrefix,
  channelId,
  channelLabel,
  wizard,
  failedReason,
  generated,
  onFocus,
}: {
  idPrefix: string;
  channelId: string;
  channelLabel: string;
  wizard: ComposeWizard;
  failedReason?: { reason: string; code: string };
  generated?: { provider: string; model: string; hashtags: readonly string[] };
  onFocus: () => void;
}) {
  const { form, captions, composed } = wizard;
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldName = `captions.${channelId}` as const;
  const value = wizard.captionValues?.[channelId] ?? "";
  const trimmed = value.trim();

  const registered = form.register(fieldName);

  /**
   * Insert at the caret, not at the end: an operator who put the cursor mid
   * sentence to add an emoji means there, and appending would move their work
   * around behind their back. Selection is restored after React re-renders.
   */
  const insert = useCallback(
    (text: string) => {
      const element = areaRef.current;
      if (!element) {
        form.setValue(fieldName, value + text, { shouldDirty: true });
        return;
      }
      const start = element.selectionStart ?? value.length;
      const end = element.selectionEnd ?? start;
      const next = value.slice(0, start) + text + value.slice(end);
      form.setValue(fieldName, next, { shouldDirty: true });
      requestAnimationFrame(() => {
        const caret = start + text.length;
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    },
    [fieldName, form, value],
  );

  const hashtags = suggestHashtags(composed?.content, generated?.hashtags);
  const usedTags = countHashtags(value);
  const paragraphs =
    trimmed.length === 0 ? 0 : trimmed.split(/\n+/).filter((line) => line.trim()).length;

  return (
    <section
      aria-labelledby={`${idPrefix}-heading`}
      className="bg-muted flex flex-col overflow-hidden rounded-2xl"
    >
      {/* Header: whose text, where it came from, and the one action that
          rewrites it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
        <h3 id={`${idPrefix}-heading`} className="text-sm font-semibold">
          Caption cho {channelLabel}
        </h3>

        <CaptionOrigin
          isPending={captions.isPending}
          generated={Boolean(generated)}
          hasText={trimmed.length > 0}
        />

        <span className="flex-1" />

        <div role="group" aria-label="Chèn biểu tượng" className="flex flex-wrap gap-1">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insert(emoji)}
              aria-label={`Chèn ${emoji}`}
              className="bg-card hover:bg-accent/40 focus-visible:ring-ring/50 size-8 cursor-pointer rounded-lg text-base transition-colors outline-none focus-visible:ring-3"
            >
              {emoji}
            </button>
          ))}
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={trimmed.length === 0}
          onClick={() => {
            form.setValue(fieldName, "", { shouldDirty: true });
            areaRef.current?.focus();
          }}
        >
          Xoá hết
        </Button>

        <Button
          type="button"
          onClick={() => captions.mutate()}
          disabled={captions.isPending}
          className="h-9 px-4"
        >
          {captions.isPending
            ? "Đang viết caption…"
            : captions.isSuccess
              ? "Nhờ AI viết lại"
              : "Nhờ AI viết caption"}
        </Button>
      </div>

      {failedReason ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive mx-4 mb-3 rounded-xl border px-3.5 py-2.5 text-sm"
        >
          Kênh này chưa có caption từ AI: {failedReason.reason}{" "}
          <span className="font-mono text-xs">({failedReason.code})</span> — hãy bấm “Nhờ AI viết
          caption” hoặc tự nhập bên dưới.
        </p>
      ) : null}

      {/* The text itself, on the raised surface: this box is the post. */}
      <div className="px-4 pb-3">
        <label htmlFor={idPrefix} className="sr-only">
          Nội dung caption cho {channelLabel}
        </label>
        <Textarea
          {...registered}
          ref={(node) => {
            registered.ref(node);
            areaRef.current = node;
          }}
          id={idPrefix}
          rows={10}
          onFocus={onFocus}
          placeholder={`Nhập caption sẽ đăng lên ${channelLabel}… hoặc nhấn “Nhờ AI viết caption”.`}
          aria-describedby={`${idPrefix}-meta`}
          className="bg-card min-h-55 resize-none rounded-xl border-0 p-4 text-sm leading-relaxed shadow-none focus-visible:ring-3"
        />
      </div>

      <div
        id={`${idPrefix}-meta`}
        className="border-border flex flex-col gap-2 border-t px-4 py-3"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Eyebrow>Gợi ý thẻ</Eyebrow>
          <span className="text-muted-foreground text-xs">
            đã dùng {usedTags} / {HASHTAG_BUDGET}
          </span>
          <span className="flex-1" />
          <span className="text-foreground-subtle font-mono text-xs">
            {trimmed.length} ký tự · {paragraphs} đoạn
          </span>
        </div>

        {hashtags.length > 0 ? (
          <div role="group" aria-label="Chèn hashtag" className="flex flex-wrap gap-1.5">
            {hashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => insert(` ${tag}`)}
                className="border-border hover:bg-card focus-visible:ring-ring/50 text-muted-foreground cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-3"
              >
                + {tag}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Chưa có gợi ý thẻ nào — nhờ AI viết caption để lấy thẻ theo sản phẩm.
          </p>
        )}

        {usedTags > HASHTAG_BUDGET ? (
          <p role="status" className="text-warning-foreground text-xs leading-relaxed">
            Caption đang có {usedTags} thẻ. Quá nhiều thẻ làm bài khó đọc và dễ bị coi là spam — vẫn
            đăng được nếu bạn muốn.
          </p>
        ) : null}

        {generated ? (
          <p className="text-muted-foreground text-xs">
            Bản nháp gần nhất do {generated.provider}/{generated.model} viết. Nội dung trong ô là bản
            bạn duyệt.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Where the text in the box came from — the design's state pill. */
function CaptionOrigin({
  isPending,
  generated,
  hasText,
}: {
  isPending: boolean;
  generated: boolean;
  hasText: boolean;
}) {
  if (isPending) return <Badge tone="info">AI đang viết…</Badge>;
  if (!hasText) return <Badge tone="warning">Chưa có nội dung</Badge>;
  if (generated) return <Badge tone="success">AI đã viết · bạn duyệt lần cuối</Badge>;
  return <Badge tone="neutral">Bạn tự viết</Badge>;
}

/** Counts the hashtags actually in the text, not the ones we offered. */
function countHashtags(value: string): number {
  return (value.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/**
 * Hashtags offered as one-click inserts. Sourced from the AI's own suggestions
 * when there are any, otherwise derived from the SAME whitelisted fields the
 * prompt was built from (business rule 2) — never from stock, price or notes.
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
