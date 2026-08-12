"use client";

import { MediaGrid } from "@/ui/components/compose/MediaGrid";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS } from "@/ui/schemas/compose.schema";

/**
 * Step 3 — review before anything is published.
 *
 * HARD RULE (CLAUDE.md business rule 2): this screen is the preview of what
 * goes on Facebook. It renders the caption, the album and the product name —
 * and NEVER stock, price or production notes. The internal stock block lives on
 * step 1 only; do not "helpfully" repeat it here.
 *
 * The final button is disabled on purpose: publishing (E5) is being built in
 * parallel and this sprint must not call it. A visible, explained disabled
 * button is honest; a button that silently does nothing is not.
 */
export function StepReview({ wizard }: { wizard: ComposeWizard }) {
  const { composed } = wizard;
  if (!composed) return null;

  const captions = wizard.captionValues ?? {};

  return (
    <div className="space-y-6">
      <section aria-labelledby="review-post-heading" className="bg-card space-y-4 rounded-xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="review-post-heading" className="text-base font-semibold">
            Bài sẽ đăng
          </h3>
          <Badge tone="info">{composed.content.code}</Badge>
        </div>

        <p className="text-sm">
          <span className="text-muted-foreground">Sản phẩm:</span>{" "}
          <span className="font-medium">{composed.content.name}</span>
        </p>

        {COMPOSE_CHANNELS.map((channel) => (
          <article key={channel.id} className="space-y-2">
            <h4 className="text-sm font-medium">{channel.label}</h4>
            <pre className="bg-muted/40 max-h-96 overflow-auto rounded-lg border p-4 text-sm break-words whitespace-pre-wrap">
              {(captions[channel.id] ?? "").trim() || "(chưa có caption)"}
            </pre>
            <p className="text-muted-foreground text-xs">
              Đây đúng là nội dung sẽ lên {channel.label}. Muốn sửa: quay lại bước duyệt caption.
            </p>
          </article>
        ))}
      </section>

      <MediaGrid media={composed.media} />

      <section
        aria-labelledby="review-publish-heading"
        className="border-border bg-muted/30 space-y-3 rounded-xl border p-5"
      >
        <h3 id="review-publish-heading" className="text-base font-semibold">
          Đăng bài
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" disabled aria-describedby="publish-disabled-reason">
            Tạo lô đăng
          </Button>
          <p id="publish-disabled-reason" className="text-muted-foreground text-sm">
            E5 đang hoàn thiện — sprint này chưa đăng. Nút sẽ mở khi phần đăng Facebook (hàng đợi
            bài, khoá chống trùng, giãn cách) hoàn tất.
          </p>
        </div>
        <p className="text-muted-foreground text-xs">
          Tự động đăng luôn mặc định TẮT: bài chỉ rời khỏi màn hình này khi có người bấm duyệt.
        </p>
      </section>

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={() => wizard.goToStep("caption")}>
          Quay lại sửa caption
        </Button>
        <Button type="button" variant="ghost" onClick={() => wizard.goToStep("san-pham")}>
          Đổi sản phẩm
        </Button>
      </div>
    </div>
  );
}
