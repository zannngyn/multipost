"use client";

import { Copy, Check, Clock, Calendar, Hash, Sparkles } from "lucide-react";
import { Token } from "@astryxdesign/core";

import { BatchStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { copyStatusMessage, useCopyToClipboard } from "@/ui/hooks/useCopyToClipboard";
import { MANUAL_PRODUCT_BADGE } from "@/ui/schemas/product-origin.schema";
import {
  formatDateTime,
  formatDurationMs,
  type BatchStatusResponse,
} from "@/ui/schemas/post-batch.schema";

const TOTALS_FIELDS = [
  { key: "total", label: "TỔNG SỐ KÊNH", tone: "neutral" },
  { key: "published", label: "ĐÃ ĐĂNG", tone: "leaf" },
  { key: "inProgress", label: "ĐANG CHẠY", tone: "indigo" },
  { key: "scheduledOnFacebook", label: "FB GIỮ LỊCH", tone: "turmeric" },
  { key: "blocked", label: "BỊ CHẶN", tone: "turmeric" },
  { key: "failed", label: "LỖI", tone: "madder" },
] as const;

export function BatchSummaryCard({ batch }: { batch: BatchStatusResponse }) {
  const { tenantId } = useActiveTenant();
  const clipboard = useCopyToClipboard("batch", {
    tenant_id: tenantId,
    batch_id: batch.batchId,
  });

  return (
    <section
      aria-labelledby="batch-summary-heading"
      className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-xs"
    >
      {/* Header Info */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2
              id="batch-summary-heading"
              className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground"
            >
              TỔNG KẾT LÔ ĐĂNG
            </h2>
            <BatchStatusBadge status={batch.status} />
          </div>
          <p className="text-sm font-medium text-foreground leading-relaxed">
            {batch.summaryMessage}
          </p>
        </div>

        {/* Product Identity Pill */}
        <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-muted/30 px-3 py-2">
          <div className="flex flex-col">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Sản phẩm
            </span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm font-bold text-foreground">
                {batch.productCode}
              </span>
              {/* An empty colour is the batch that covers EVERY colour — saying
                  nothing makes it look like a single-colour batch, which is a
                  different job with a different scope. */}
              <span className="text-xs text-muted-foreground">
                · {batch.color.trim().length > 0 ? batch.color : "Tất cả màu"}
              </span>
            </div>
          </div>
          {batch.productOrigin === "manual" && (
            <Token
              size="sm"
              color="orange"
              label={MANUAL_PRODUCT_BADGE}
              description="Thông tin sản phẩm do người vận hành nhập tay."
            />
          )}
        </div>
      </div>

      {/* Signature Stat Tape (6 connected cells) */}
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/80 bg-border/40 gap-px sm:grid-cols-3 lg:grid-cols-6">
        {TOTALS_FIELDS.map((field) => {
          const count = batch.totals[field.key];
          const hasItems = count > 0;

          return (
            <div
              key={field.key}
              className={`flex flex-col justify-between p-3.5 transition-colors ${field.tone === "leaf" && hasItems
                  ? "bg-leaf/10"
                  : field.tone === "madder" && hasItems
                    ? "bg-madder/10"
                    : field.tone === "turmeric" && hasItems
                      ? "bg-turmeric/10"
                      : field.tone === "indigo" && hasItems
                        ? "bg-accent/40"
                        : "bg-card"
                }`}
            >
              <span className="font-mono text-[10px] font-semibold tracking-wider text-muted-foreground">
                {field.label}
              </span>
              <span
                className={`font-mono text-2xl font-bold tracking-tight tabular-nums pt-1 ${field.tone === "leaf" && hasItems
                    ? "text-leaf-deep"
                    : field.tone === "madder" && hasItems
                      ? "text-madder"
                      : field.tone === "turmeric" && hasItems
                        ? "text-turmeric-deep"
                        : field.tone === "indigo" && hasItems
                          ? "text-primary"
                          : "text-foreground"
                  }`}
              >
                {count}
              </span>
            </div>
          );
        })}
      </div>

      {/* Metadata Bar */}
      <div className="grid grid-cols-1 gap-3 pt-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Calendar className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span>
            Bắt đầu:{" "}
            <strong className="font-mono text-foreground font-medium tabular-nums">
              {formatDateTime(batch.startedAt)}
            </strong>
          </span>
        </div>

        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span>
            Kết thúc:{" "}
            <strong className="font-mono text-foreground font-medium tabular-nums">
              {batch.finishedAt ? formatDateTime(batch.finishedAt) : "Đang chạy…"}
            </strong>
          </span>
        </div>

        {batch.durationMs !== null && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span>
              Thời gian:{" "}
              <strong className="font-mono text-foreground font-medium tabular-nums">
                {formatDurationMs(batch.durationMs)}
              </strong>
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-1 sm:justify-start">
          <div className="flex items-center gap-1.5 overflow-hidden text-muted-foreground">
            <Hash className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono text-[11px]">
              {batch.batchId}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void clipboard.copy(batch.batchId)}
            title="Sao chép mã lô"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            {clipboard.state === "copied" ? (
              <Check className="size-3 text-leaf-deep" />
            ) : (
              <Copy className="size-3" />
            )}
            {/* An icon-only button has no name without this. */}
            <span className="sr-only">Sao chép mã lô {batch.batchId}</span>
          </button>
        </div>
      </div>

      {/* The copy either happened or it did not, and the operator is told which:
          a tick that appears whatever the browser did is worse than no tick. */}
      <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
        {copyStatusMessage(clipboard.state, "mã lô")}
      </p>
    </section>
  );
}
