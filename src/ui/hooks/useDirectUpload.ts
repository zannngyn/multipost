"use client";

import { useCallback, useRef, useState } from "react";

import type { UploadResponse } from "@/ui/schemas/compose.schema";
import { ApiError } from "@/ui/services/api-error";
import { confirmUpload, postFileToStorage, requestUploadTickets } from "@/ui/services/upload.api";

import { nextProgress, planUploadOrder } from "./direct-upload-queue";

/**
 * Drives the browser -> MinIO -> confirm path (mode B, docs/07 §4.1). The
 * pure decisions (candidate shape, progress maths) live in
 * `direct-upload-queue.ts` so they are unit-testable without a DOM; this hook
 * is the thin, stateful shell around them.
 */

/** How many files POST at once. Three keeps a home connection responsive. */
const CONCURRENCY = 3;

export interface DirectUploadState {
  readonly isUploading: boolean;
  readonly progress: number;
  readonly error: string | null;
}

export interface UseDirectUploadResult extends DirectUploadState {
  upload: (productCode: string, files: readonly File[]) => Promise<UploadResponse>;
  cancel: () => void;
}

export function useDirectUpload(): UseDirectUploadResult {
  const [state, setState] = useState<DirectUploadState>({
    isUploading: false,
    progress: 0,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ isUploading: false, progress: 0, error: null });
  }, []);

  const upload = useCallback(
    async (productCode: string, files: readonly File[]): Promise<UploadResponse> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ isUploading: true, progress: 0, error: null });

      try {
        const tickets = await requestUploadTickets(
          { productCode, files: planUploadOrder(files) },
          controller.signal,
        );

        // Paired by `sourceIndex`, NEVER by file name: two same-named photos
        // in one album is ordinary, and matching by name would silently
        // drop one with nobody told.
        const jobs = tickets.issued
          .map((ticket) => ({ ticket, file: files[ticket.sourceIndex] }))
          .filter((job): job is { ticket: (typeof tickets.issued)[number]; file: File } => job.file !== undefined);

        let done = 0;
        // A manual worker pool instead of Promise.all: caps concurrent POSTs
        // at CONCURRENCY, and lets one failure abort the rest via `signal`
        // rather than silently confirming a partial album.
        const queue = [...jobs];
        let failure: unknown = null;

        async function worker(): Promise<void> {
          for (;;) {
            if (failure) return;
            const job = queue.shift();
            if (!job) return;
            try {
              await postFileToStorage(
                { postUrl: job.ticket.postUrl, formFields: job.ticket.formFields, file: job.file },
                controller.signal,
              );
            } catch (error) {
              failure = error;
              controller.abort();
              throw error;
            }
            done += 1;
            setState((prev) => ({ ...prev, progress: nextProgress(done, jobs.length) }));
          }
        }

        try {
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
        } catch (settledError) {
          // Prefer the recorded failure: other workers racing on the same
          // aborted signal can reject first with a generic AbortError, and
          // that must not bury the real, file-named cause.
          throw failure ?? settledError;
        }

        const result = await confirmUpload(
          { productCode, assets: jobs.map((job) => ({ assetId: job.ticket.assetId })) },
          controller.signal,
        );

        setState({ isUploading: false, progress: 100, error: null });
        return result;
      } catch (error) {
        // Never swallowed: a Vietnamese message reaches the operator and the
        // error is rethrown so the caller's own error handling still runs.
        const message = ApiError.is(error)
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : "Tải file lên thất bại.";
        setState({ isUploading: false, progress: 0, error: message });
        throw error;
      } finally {
        abortRef.current = null;
      }
    },
    [],
  );

  return { ...state, upload, cancel };
}
