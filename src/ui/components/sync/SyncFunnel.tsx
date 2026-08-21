"use client";

import {
  Divider,
  Grid,
  HStack,
  Heading,
  ProgressBar,
  Stack,
  StackItem,
  StatusDot,
  Text,
} from "@astryxdesign/core";
import { Fragment, useId } from "react";

import { formatClock, formatCount, percentOf } from "@/ui/components/sync/sync-format";
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
 * The bar per stage is the SHARE THAT WENT ON, drawn with the design system's
 * own ProgressBar. The previous version drew a stacked bar out of hand-sized
 * spans, which meant a runtime `style={{width}}` on every segment and a private
 * colour table; the segments are still all there, each with its own count and
 * its own dot, right underneath. Nothing that was on screen was dropped — the
 * geometry stopped being hand-drawn.
 *
 * The arithmetic lives in `sync-funnel-stages.ts`.
 */

/** Segment tone -> the dot beside its count. Colour never travels alone. */
const SEGMENT_DOT: Record<SegmentTone, "accent" | "neutral" | "warning"> = {
  kept: "accent",
  neutral: "neutral",
  rejected: "warning",
};

const SEGMENT_TEXT: Record<SegmentTone, "primary" | "secondary"> = {
  kept: "primary",
  neutral: "secondary",
  rejected: "primary",
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
    <Stack as="section" direction="vertical" gap={3} aria-labelledby={headingId}>
      <Stack direction="vertical" gap={0.5}>
        <Heading level={2} id={headingId}>
          Dòng dữ liệu của lần chạy này
        </Heading>
        <Text type="supporting">Số vào → số bỏ lại → số đi tiếp.</Text>
      </Stack>

      <Stack direction="vertical" gap={0}>
        {stages.map((stage, index) => (
          <Fragment key={stage.ordinal}>
            {index > 0 ? <Divider /> : null}
            <StageRow stage={stage} />
          </Fragment>
        ))}

        <Divider />

        <HStack gap={4} paddingBlock={4} align="start" wrap="wrap">
          <StageHeading
            ordinal="03"
            title="Ghi vào hệ thống"
            detail={finishedAt ? `xong ${formatClock(finishedAt)}` : "chưa kết thúc"}
          />
          <StackItem size="fill">
            <Grid columns={{ minWidth: 132, max: 4 }} gap={4}>
              <WriteCell label="Sản phẩm đã ghi" value={counts.productsWritten} />
              <WriteCell label="File đã ghi" value={counts.mediaWritten} />
              <WriteCell label="Sản phẩm đã xoá" value={counts.productsDeleted} />
              <WriteCell label="File đã xoá" value={counts.mediaDeleted} />
            </Grid>
          </StackItem>
        </HStack>
      </Stack>
    </Stack>
  );
}

function StageRow({ stage }: { stage: Stage }) {
  const share = percentOf(stage.forwardValue, stage.total);

  return (
    <HStack gap={4} paddingBlock={4} align="start" wrap="wrap">
      <StageHeading ordinal={stage.ordinal} title={stage.title} detail={stage.totalLabel} />

      <StackItem size="fill">
        {/* No input means no percentage: "0%" would read as a loss that never
            happened (core-dashboard-analytics §4). */}
        {stage.total <= 0 ? (
          <Text type="supporting">{stage.emptyLabel}</Text>
        ) : (
          <Stack direction="vertical" gap={2}>
            {/* `end`, not `center`: Astryx has no baseline alignment, and a
                supporting label centred against a 3xl number floats in the
                middle of its line box. Bottom-aligned it sits on the number. */}
            <HStack gap={2} align="end" wrap="wrap">
              <Text size="3xl" weight="semibold" hasTabularNumbers>
                {formatCount(stage.forwardValue)}
              </Text>
              <Text type="supporting">
                {stage.forwardLabel}
                {share !== null ? ` · ${share} số đã vào` : ""}
              </Text>
            </HStack>

            <ProgressBar
              label={`${stage.forwardLabel} trên tổng số đã vào chặng ${stage.ordinal}`}
              isLabelHidden
              value={stage.forwardValue}
              max={stage.total}
            />

            <HStack gap={4} align="center" wrap="wrap">
              {stage.segments.map((segment) => (
                <HStack key={segment.key} gap={1.5} align="center">
                  <StatusDot variant={SEGMENT_DOT[segment.tone]} label={segment.label} />
                  <Text color={SEGMENT_TEXT[segment.tone]}>{segment.label}</Text>
                  <Text type="code" color={SEGMENT_TEXT[segment.tone]} hasTabularNumbers>
                    {formatCount(segment.value)}
                  </Text>
                </HStack>
              ))}
            </HStack>

            <StageNote facts={stage.facts} />
          </Stack>
        )}
      </StackItem>
    </HStack>
  );
}

/** "N mã không có trên Sheet · N file cần rà soát" — facts, not a sentence. */
function StageNote({ facts }: { facts: readonly StageFact[] }) {
  if (facts.length === 0) return null;

  return (
    <Text type="supporting">
      {facts.map((fact, index) => (
        <Fragment key={fact.key}>
          {index > 0 ? " · " : null}
          <Text color="primary" weight="medium" hasTabularNumbers>
            {formatCount(fact.value)}
          </Text>{" "}
          {fact.label}
        </Fragment>
      ))}
    </Text>
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
    <Stack direction="vertical" gap={0.5} width={144}>
      {/* The ordinal is not decoration: these three stages are a sequence, and
          the number is how an operator names one out loud to support. */}
      <Text type="code" size="2xs" color="secondary">
        {ordinal}
      </Text>
      <Heading level={3}>{title}</Heading>
      <Text type="code" size="2xs" color="secondary" hasTabularNumbers>
        {detail}
      </Text>
    </Stack>
  );
}

function WriteCell({ label, value }: { label: string; value: number }) {
  return (
    <Stack direction="vertical" gap={0.5}>
      <Text size="2xl" weight="semibold" hasTabularNumbers color={value === 0 ? "placeholder" : "primary"}>
        {formatCount(value)}
      </Text>
      <Text type="supporting">{label}</Text>
    </Stack>
  );
}
