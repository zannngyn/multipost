"use client";

import { MediaGrid } from "@/ui/components/compose/MediaGrid";
import { PublishPanel } from "@/ui/components/compose/PublishPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { Badge } from "@/ui/components/ui/badge";
import type { PublishForm } from "@/ui/hooks/usePublishForm";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS, VIDEO_TARGET_LABELS } from "@/ui/schemas/compose.schema";

/**
 * Step 3 — review before anything is published.
 *
 * HARD RULE (CLAUDE.md business rule 2): this screen is the preview of what
 * goes on Facebook. It renders the caption, the album and the product name —
 * and NEVER stock, price or production notes. The internal stock block lives on
 * step 1 only; do not "helpfully" repeat it here.
 *
 * The channel picker and the schedule live in <PublishPanel> beside it, and the
 * action that fires them lives in the wizard footer — so this column stays what
 * it says it is: the preview of the post.
 */
export function StepReview({
  wizard,
  publish,
}: {
  wizard: ComposeWizard;
  publish: PublishForm;
}) {
  const { composed } = wizard;
  if (!composed) return null;

  const captions = wizard.captionValues ?? {};

  return (
    <div className="flex flex-col items-start gap-5 @4xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <section
          aria-labelledby="review-post-heading"
          className="bg-card border-border flex flex-col gap-3.5 rounded-xl border p-5"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3 id="review-post-heading" className="text-base font-semibold">
              Bài sẽ đăng
            </h3>
            <span className="text-muted-foreground font-mono text-xs">{composed.content.code}</span>
            <Badge tone="neutral">
              {composed.video ? VIDEO_TARGET_LABELS[composed.video.target] : "Bài ảnh"}
            </Badge>
            <span className="flex-1" />
            <span className="text-muted-foreground text-xs">
              Sản phẩm: <span className="text-foreground font-medium">{composed.content.name}</span>
            </span>
          </div>

          {COMPOSE_CHANNELS.map((channel) => {
            const text = (captions[channel.id] ?? "").trim();

            return (
              <article key={channel.id} className="bg-accent/15 rounded-xl p-4">
                <h4 className="flex items-center gap-2 pb-2.5 text-sm font-medium">
                  <span
                    aria-hidden="true"
                    className="bg-info/20 text-info-foreground flex size-5 items-center justify-center rounded-md text-xs font-semibold"
                  >
                    f
                  </span>
                  {channel.label}
                </h4>
                <p
                  className={
                    text.length > 0
                      ? "max-h-96 overflow-auto text-sm leading-relaxed break-words whitespace-pre-wrap"
                      : "text-muted-foreground text-sm italic"
                  }
                >
                  {text.length > 0 ? text : "(chưa có caption)"}
                </p>
                <p className="text-muted-foreground pt-2.5 text-xs leading-relaxed">
                  Đây đúng là nội dung sẽ lên {channel.label}. Muốn sửa: quay lại bước duyệt caption.
                </p>
              </article>
            );
          })}
        </section>

        {composed.video ? <VideoSpecCard video={composed.video} clip={composed.media[0]} /> : null}

        {/* Read-only on purpose: this step confirms what will happen. Rearranging
            belongs to step 1, where the album is chosen. */}
        <MediaGrid media={wizard.album} />
      </div>

      <PublishPanel wizard={wizard} publish={publish} />
    </div>
  );
}
