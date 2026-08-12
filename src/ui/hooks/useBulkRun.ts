"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isBulkSkipCode,
  renderCaptionTemplate,
  type BulkCaptionMode,
  type BulkRowStatus,
} from "@/ui/schemas/bulk.schema";
import { COMPOSE_CHANNELS } from "@/ui/schemas/compose.schema";
import { ApiError } from "@/ui/services/api-error";
import { composePost, createPostBatch, generateCaptions } from "@/ui/services/post.api";

/**
 * Logic layer of "Chạy hàng loạt" (E10.5), docs/07 §4.1.
 *
 * Why a hand-written sequential loop and not a TanStack mutation per code:
 * the run is ORDERED and must survive a failing code. Business rule 6 says one
 * channel failing never stops another; the same reasoning one level up says one
 * PRODUCT failing never stops the batch. So every code is tried, its outcome is
 * recorded on its own row, and the loop moves on.
 *
 * Where each rule is enforced — none of it here:
 *  - stock gate: `composePost` (server) refuses a sold-out code, twice more
 *    before the Graph call. This hook only reads the refusal and skips.
 *  - whitelist (rule 2): the manual template can only reference {code}/{name};
 *    the AI path sends `composed.content`, which has no price/stock field.
 *  - duplicate lock: `createPostBatch` (server) owns it.
 *
 * Honest limitation, stated on the screen too: the loop runs IN THE BROWSER.
 * Closing the tab stops the remaining codes — batches already created keep
 * running on the server. A server-side bulk job is a later epic.
 */

/** Phase 1 generates one caption (Facebook) and shares it across the channels. */
const BASE_CHANNEL_ID = COMPOSE_CHANNELS[0].id;

export interface BulkRunRow {
  code: string;
  status: BulkRowStatus;
  /** Filled in once the product was found — helps recognise the code. */
  productName: string | null;
  /** Vietnamese sentence: why it was skipped or what failed. */
  reason: string | null;
  errorCode: string | null;
  /** Set only on success — links to /batches/[id]. */
  batchId: string | null;
  channelCount: number;
}

export interface BulkRunInput {
  tenantId: string;
  codes: readonly string[];
  channelIds: readonly string[];
  captionMode: BulkCaptionMode;
  captionTemplate: string;
  /**
   * E8.1 — one publish instant (ISO) for EVERY code and channel of this run;
   * null = đăng ngay. The spacing gate still keeps the posts of one channel
   * apart, so a run of 20 codes hẹn cùng giờ goes out in order, not at once.
   */
  scheduledAt?: string | null;
}

export type BulkRunPhase = "idle" | "running" | "stopping" | "finished";

export interface BulkRunSummary {
  total: number;
  done: number;
  skipped: number;
  failed: number;
  cancelled: number;
  /** Rows already settled — the "12/50" of the progress line. */
  processed: number;
}

function initialRows(codes: readonly string[], channelCount: number): BulkRunRow[] {
  return codes.map((code) => ({
    code,
    status: "pending" as BulkRowStatus,
    productName: null,
    reason: null,
    errorCode: null,
    batchId: null,
    channelCount,
  }));
}

function summarise(rows: readonly BulkRunRow[]): BulkRunSummary {
  const count = (status: BulkRowStatus) => rows.filter((row) => row.status === status).length;
  const done = count("done");
  const skipped = count("skipped");
  const failed = count("error");
  const cancelled = count("cancelled");
  return {
    total: rows.length,
    done,
    skipped,
    failed,
    cancelled,
    processed: done + skipped + failed + cancelled,
  };
}

/** Nothing is thrown out of the loop: every failure becomes a row outcome. */
function outcomeFromError(error: unknown): Pick<BulkRunRow, "status" | "reason" | "errorCode"> {
  if (ApiError.is(error)) {
    return {
      status: isBulkSkipCode(error.code) ? "skipped" : "error",
      reason: error.userMessage,
      errorCode: error.code,
    };
  }
  // Should not happen (the data layer only throws ApiError) — but an unknown
  // throwable must still land on the row instead of killing the whole run.
  return {
    status: "error",
    reason:
      error instanceof Error && error.message
        ? `Lỗi không xác định: ${error.message}`
        : "Lỗi không xác định khi xử lý mã này.",
    errorCode: "UNKNOWN",
  };
}

export function useBulkRun() {
  const [rows, setRows] = useState<BulkRunRow[]>([]);
  const [phase, setPhase] = useState<BulkRunPhase>("idle");

  const stopRef = useRef(false);
  /** Guards against a second "Chạy" click and against a stale run writing rows. */
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // The loop lives in this tab: leaving mid-run abandons the remaining codes,
  // so warn (web-bulk-actions rule 7 — warn for synchronous work, not for a
  // server-side job). Nothing already created is lost either way.
  useEffect(() => {
    if (phase !== "running" && phase !== "stopping") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [phase]);

  // Unmount mid-run: stop the loop and drop the in-flight request.
  useEffect(
    () => () => {
      stopRef.current = true;
      runIdRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const patchRow = useCallback((runId: number, index: number, patch: Partial<BulkRunRow>) => {
    if (runId !== runIdRef.current) return;
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }, []);

  const stop = useCallback(() => {
    if (!stopRef.current) stopRef.current = true;
    setPhase((current) => (current === "running" ? "stopping" : current));
  }, []);

  const reset = useCallback(() => {
    if (phase === "running" || phase === "stopping") return;
    runIdRef.current += 1;
    setRows([]);
    setPhase("idle");
  }, [phase]);

  const start = useCallback(
    async (input: BulkRunInput) => {
      // --- Edge cases first: a run with nothing to do must not start --------
      if (phase === "running" || phase === "stopping") return;
      if (input.codes.length === 0 || input.channelIds.length === 0) return;

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      stopRef.current = false;
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      setRows(initialRows(input.codes, input.channelIds.length));
      setPhase("running");

      for (let index = 0; index < input.codes.length; index += 1) {
        if (runId !== runIdRef.current) return;

        // Cancellation is checked BEFORE the next code, never in the middle of
        // one: a half-created batch would be worse than one extra post.
        if (stopRef.current) {
          setRows((current) =>
            current.map((row, position) =>
              position >= index && row.status === "pending"
                ? {
                    ...row,
                    status: "cancelled" as BulkRowStatus,
                    reason: "Đã dừng trước khi chạy mã này — mã chưa bị ảnh hưởng gì.",
                  }
                : row,
            ),
          );
          break;
        }

        const code = input.codes[index];
        try {
          patchRow(runId, index, { status: "composing", reason: null, errorCode: null });
          const composed = await composePost({ tenantId: input.tenantId, productCode: code }, signal);

          if (runId !== runIdRef.current) return;
          patchRow(runId, index, { status: "captioning", productName: composed.content.name });

          let caption = "";
          if (input.captionMode === "template") {
            caption = renderCaptionTemplate(input.captionTemplate, {
              code: composed.content.code,
              name: composed.content.name,
            }).trim();
          } else {
            const captions = await generateCaptions(
              {
                tenantId: composed.tenantId,
                content: composed.content,
                channels: [BASE_CHANNEL_ID],
              },
              signal,
            );
            caption =
              captions.generated.find((item) => item.channelId === BASE_CHANNEL_ID)?.text.trim() ??
              "";
            if (caption.length === 0) {
              // A failed channel is reported by the usecase with a reason —
              // never dropped (business rule 5).
              const failure = captions.failed[0];
              patchRow(runId, index, {
                status: "error",
                reason: failure
                  ? `AI không viết được caption: ${failure.reason}`
                  : "AI không trả về caption nào cho mã này.",
                errorCode: failure?.code ?? "CAPTION_EMPTY",
              });
              continue;
            }
          }

          if (caption.length === 0) {
            patchRow(runId, index, {
              status: "error",
              reason: "Mẫu caption cho mã này ra rỗng — kiểm tra lại mẫu dùng chung.",
              errorCode: "CAPTION_EMPTY",
            });
            continue;
          }

          if (runId !== runIdRef.current) return;
          patchRow(runId, index, { status: "creating" });

          const captionByChannel: Record<string, string> = {};
          for (const channelId of input.channelIds) captionByChannel[channelId] = caption;

          const batch = await createPostBatch(
            {
              tenantId: input.tenantId,
              productCode: composed.content.code,
              channelIds: input.channelIds,
              captionByChannel,
              scheduledAt: input.scheduledAt ?? null,
              // Cover first — `composePost` already ordered the album that way.
              media: composed.media.map((asset) => ({
                driveFileId: asset.driveFileId,
                fileName: asset.fileName,
                kind: asset.kind,
              })),
            },
            signal,
          );

          patchRow(runId, index, {
            status: "done",
            batchId: batch.batchId,
            reason: batch.warnings.length > 0 ? batch.warnings.join(" · ") : null,
          });
        } catch (error) {
          // Never rethrown: the row carries the failure and the run continues.
          if (signal.aborted || runId !== runIdRef.current) return;
          patchRow(runId, index, outcomeFromError(error));
        }
      }

      if (runId === runIdRef.current) setPhase("finished");
    },
    [patchRow, phase],
  );

  return {
    rows,
    phase,
    summary: summarise(rows),
    isRunning: phase === "running" || phase === "stopping",
    start,
    stop,
    reset,
  };
}

export type BulkRun = ReturnType<typeof useBulkRun>;
