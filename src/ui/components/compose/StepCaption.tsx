"use client";

import { useId } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Textarea } from "@/ui/components/ui/textarea";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS } from "@/ui/schemas/compose.schema";

/**
 * Step 2 — one caption per channel: generate with AI, edit by hand, or write it
 * from scratch. Nothing is auto-approved and nothing is auto-posted.
 *
 * Manual entry is a first-class path, not a fallback bolted on: Phase 1 runs
 * without an AI key on most machines, and an operator must still be able to
 * finish a post. The textarea is therefore always editable, whether or not the
 * AI answered.
 *
 * Business rule 2: only the four whitelisted fields were sent to the model, and
 * nothing on this screen shows stock or price.
 */
export function StepCaption({ wizard }: { wizard: ComposeWizard }) {
  const fieldId = useId();
  const { form, captions, composed } = wizard;

  if (!composed) return null;

  const failedByChannel = new Map(
    (captions.data?.failed ?? []).map((item) => [item.channelId, item]),
  );
  const generatedByChannel = new Map(
    (captions.data?.generated ?? []).map((item) => [item.channelId, item]),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="lg" onClick={() => captions.mutate()} disabled={captions.isPending}>
          {captions.isPending
            ? "Đang viết caption…"
            : captions.isSuccess
              ? "Viết lại bằng AI"
              : "Tạo caption bằng AI"}
        </Button>
        <p className="text-muted-foreground text-sm">
          Hoặc tự nhập caption bên dưới. Bạn luôn là người duyệt lần cuối.
        </p>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {captions.isPending
          ? "Đang tạo caption bằng AI"
          : captions.isSuccess
            ? "Đã tạo xong caption"
            : ""}
      </p>

      {captions.isError ? (
        <ApiErrorNotice
          error={captions.error}
          onRetry={() => captions.mutate()}
          extraAction={
            <Button
              type="button"
              variant="outline"
              onClick={() => form.setFocus(`captions.${COMPOSE_CHANNELS[0].id}`)}
            >
              Tự nhập caption
            </Button>
          }
        />
      ) : null}

      {COMPOSE_CHANNELS.map((channel) => {
        const textareaId = `${fieldId}-${channel.id}`;
        const failed = failedByChannel.get(channel.id);
        const generated = generatedByChannel.get(channel.id);
        const value = wizard.captionValues?.[channel.id] ?? "";

        return (
          <section
            key={channel.id}
            aria-labelledby={`${textareaId}-heading`}
            className="bg-card space-y-3 rounded-xl border p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${textareaId}-heading`} className="text-base font-semibold">
                Caption cho {channel.label}
              </h3>
              {generated ? (
                <Badge tone="success">
                  AI: {generated.provider}/{generated.model}
                </Badge>
              ) : value.trim().length > 0 ? (
                <Badge tone="info">Nhập tay</Badge>
              ) : (
                <Badge tone="warning">Chưa có caption</Badge>
              )}
            </div>

            {failed ? (
              <p
                role="alert"
                className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
              >
                Kênh này chưa có caption từ AI: {failed.reason}{" "}
                <span className="font-mono text-xs">({failed.code})</span> — hãy bấm “Viết lại” hoặc
                tự nhập bên dưới.
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={textareaId} className="sr-only">
                Nội dung caption cho {channel.label}
              </label>
              <Textarea
                id={textareaId}
                {...form.register(`captions.${channel.id}`)}
                rows={10}
                placeholder={`Nhập caption sẽ đăng lên ${channel.label}…`}
                aria-describedby={`${textareaId}-meta`}
              />
              <p id={`${textareaId}-meta`} className="text-muted-foreground text-xs">
                {value.trim().length === 0
                  ? "Chưa có nội dung. Bài chưa thể chuyển sang bước xem lại."
                  : `${value.trim().length} ký tự · sửa trực tiếp tại đây, thay đổi được giữ khi bạn đi qua lại giữa các bước.`}
              </p>
            </div>

            {generated && generated.hashtags.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                Hashtag AI đề xuất: {generated.hashtags.join(" ")}
              </p>
            ) : null}
          </section>
        );
      })}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={() => wizard.goToStep("san-pham")}>
          Quay lại
        </Button>
        <Button
          type="button"
          size="lg"
          onClick={() => wizard.goToStep("xem-lai")}
          disabled={!wizard.hasEveryCaption}
        >
          Tiếp tục: xem lại
        </Button>
        {!wizard.hasEveryCaption ? (
          <p className="text-muted-foreground self-center text-xs">
            Mỗi kênh cần một caption trước khi xem lại.
          </p>
        ) : null}
      </div>
    </div>
  );
}
