"use client";

import { Fragment, useId } from "react";

import { cn } from "@/shared/utils";
import { formatClock, formatCount, percentOf, segmentWidth } from "@/ui/components/sync/sync-format";
import {
  buildStages,
  type SegmentTone,
  type Stage,
  type StageFact,
} from "@/ui/components/sync/sync-funnel-stages";
import type { SyncRunCounts } from "@/ui/schemas/sync.schema";

/**
 * The numbers of one run, read as a flow instead of a wall of tiles: how many
 * things came in, how many were left behind and why, how many went on.
 *
 * Fifteen equal-sized counters could not answer "vì sao chỉ có 9.132 ảnh trong
 * hệ thống khi Drive có 14.987 file" — three stages with the losses named can.
 *
 * The stacked bar is an ILLUSTRATION: it is `aria-hidden`, and every number it
 * encodes is repeated as text in the legend right below it
 * (core-dashboard-analytics §7 — a chart with no textual equivalent is invisible
 * to a screen reader). The arithmetic lives in `sync-funnel-stages.ts`.
 */

const SEGMENT_BAR: Record<SegmentTone, string> = {
  kept: "bg-primary",
  neutral: "bg-muted-foreground/40",
  rejected: "bg-warning",
};

const SEGMENT_TEXT: Record<SegmentTone, string> = {
  kept: "text-foreground",
  neutral: "text-muted-foreground",
  rejected: "text-warning-foreground",
};

export function SyncFunnel({
  counts,
  finishedAt,
}: {
  counts: SyncRunCounts;
  /** Null while the run has not finished — stage 03 then has no clock. */
  finishedAt: string | null;
}) {
  const headingId = `${useId()}-funnel`;
  const stages = buildStages(counts);

  return (
    <section aria-labelledby={headingId} className="@container space-y-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          Dòng dữ liệu của lần chạy này
        </h2>
        <p className="text-muted-foreground text-sm">Số vào → số bỏ lại → số đi tiếp.</p>
      </div>

      <div className="bg-card border-border overflow-hidden rounded-xl border">
        {stages.map((stage) => (
          <StageRow key={stage.ordinal} stage={stage} />
        ))}

        <div className="border-border flex flex-col gap-3 border-t p-4 @lg:flex-row @lg:gap-4">
          <StageHeading
            ordinal="03"
            title="Ghi vào hệ thống"
            detail={finishedAt ? `xong ${formatClock(finishedAt)}` : "chưa kết thúc"}
          />
          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-3 @md:grid-cols-4">
            <WriteCell label="Sản phẩm đã ghi" value={counts.productsWritten} />
            <WriteCell label="File đã ghi" value={counts.mediaWritten} />
            <WriteCell label="Sản phẩm đã xoá" value={counts.productsDeleted} />
            <WriteCell label="File đã xoá" value={counts.mediaDeleted} />
          </dl>
        </div>
      </div>
    </section>
  );
}

function StageRow({ stage }: { stage: Stage }) {
  const share = percentOf(stage.forwardValue, stage.total);

  return (
    <div className="border-border flex flex-col gap-3 border-b p-4 @lg:flex-row @lg:gap-4">
      <StageHeading ordinal={stage.ordinal} title={stage.title} detail={stage.totalLabel} />

      <div className="min-w-0 flex-1 space-y-2.5">
        {/* No input means no percentage: "0%" would read as a loss that never
            happened (core-dashboard-analytics §4). */}
        {stage.total <= 0 ? (
          <p className="text-muted-foreground text-sm">{stage.emptyLabel}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-3xl leading-8 font-semibold tabular-nums">
                {formatCount(stage.forwardValue)}
              </span>
              <span className="text-muted-foreground text-sm">
                {stage.forwardLabel}
                {share !== null ? ` · ${share}% số đã vào` : ""}
              </span>
            </p>

            <div
              aria-hidden="true"
              className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full"
            >
              {stage.segments.map((segment) => (
                <span
                  key={segment.key}
                  className={cn("h-full", SEGMENT_BAR[segment.tone])}
                  // Data-driven geometry, not a design value: the share of a
                  // segment is only known at runtime, so it cannot be a class.
                  style={{ width: segmentWidth(segment.value, stage.total) }}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {stage.segments.map((segment) => (
                  <div key={segment.key} className="flex items-center gap-1.5">
                    <dt
                      className={cn("flex items-center gap-1.5 text-sm", SEGMENT_TEXT[segment.tone])}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("size-2 shrink-0 rounded-xs", SEGMENT_BAR[segment.tone])}
                      />
                      {segment.label}
                    </dt>
                    <dd
                      className={cn("font-mono text-sm tabular-nums", SEGMENT_TEXT[segment.tone])}
                    >
                      {formatCount(segment.value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <StageNote facts={stage.facts} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "N mã không có trên Sheet · N file cần rà soát" — facts, not a sentence. */
function StageNote({ facts }: { facts: readonly StageFact[] }) {
  return (
    <p className="text-muted-foreground text-sm @lg:ml-auto">
      {facts.map((fact, index) => (
        <Fragment key={fact.key}>
          {index > 0 ? " · " : null}
          <span className="text-foreground font-medium tabular-nums">
            {formatCount(fact.value)}
          </span>{" "}
          {fact.label}
        </Fragment>
      ))}
    </p>
  );
}

function StageHeading({
  ordinal,
  title,
  detail,
}: {
  ordinal: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="space-y-0.5 @lg:w-36 @lg:shrink-0">
      <p className="text-foreground-subtle font-mono text-xs">{ordinal}</p>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground font-mono text-xs tabular-nums">{detail}</p>
    </div>
  );
}

function WriteCell({ label, value }: { label: string; value: number }) {
  return (
    // DOM order stays dt -> dd (valid <dl>, and a screen reader hears the label
    // before the number); the column is reversed visually, number on top.
    <div className="flex flex-col-reverse gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-2xl leading-8 font-semibold tabular-nums">{formatCount(value)}</dd>
    </div>
  );
}
