"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptionTone } from "@/shared/caption-tone";
import {
  fanOutPlan,
  runCaptionFanOut,
  type CaptionFanOutStatus,
} from "@/ui/components/compose/caption-fanout";
import { COMPOSE_CHANNELS, type ProductContent } from "@/ui/schemas/compose.schema";
import { ApiError } from "@/ui/services/api-error";
import { generateCaptions } from "@/ui/services/post.api";

/**
 * "Viết caption cho N trang" — one press, one caption per selected Fanpage.
 *
 * WHY N CALLS AND NOT ONE: `POST /api/posts/captions` takes the PLATFORM
 * catalogue (`["facebook"]`), never a Fanpage id — the prompt is built from the
 * product, so there is nothing per-Page to send. Asking N times is what
 * produces N different texts, which is the whole point: brief §7.2 and the
 * server's validator D1 both refuse a post whose channels carry the same words.
 *
 * Rules this hook exists to keep (CLAUDE.md business rule 6 — one channel
 * failing must not stop the others):
 *  - every channel gets its OWN status and its OWN reason on failure. Nothing
 *    is aggregated into "có lỗi" and nothing is swallowed;
 *  - a failed channel leaves whatever text it already had. A half-written
 *    caption is never overwritten with an empty string;
 *  - progress is visible while it runs (`done` / `total`), because N sequential
 *    AI calls take tens of seconds and a frozen button reads as broken;
 *  - a second run supersedes the first: late answers from the previous run are
 *    dropped by the generation counter instead of landing on top of newer text.
 *
 * Concurrency is capped (`fanOutPlan`): the AI gateway is rate-limited per
 * tenant and firing ten calls at once buys nothing but 429s.
 */

export type { CaptionFanOutStatus };

export interface CaptionFanOutState {
  /** channelId -> where its call has got to. */
  readonly statuses: Readonly<Record<string, CaptionFanOutStatus>>;
  /** channelId -> Vietnamese reason, present only for a failed channel. */
  readonly errors: Readonly<Record<string, string>>;
  readonly isRunning: boolean;
  /** Channels finished (successfully or not) in the current run. */
  readonly done: number;
  readonly total: number;
  /** Starts a run for exactly these channels. */
  readonly run: (channelIds: readonly string[]) => void;
  /** Clears every status — used when the product changes under the screen. */
  readonly reset: () => void;
}

export function useCaptionFanOut(input: {
  /** Whitelisted product facts. Null before anything is composed. */
  content: ProductContent | null;
  tone: CaptionTone;
  /** Where a channel's finished caption goes. */
  onText: (channelId: string, text: string) => void;
  /** Told once, after the last channel settles, so the caller can check D1. */
  onSettled?: () => void;
}): CaptionFanOutState {
  const [statuses, setStatuses] = useState<Record<string, CaptionFanOutStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);

  /**
   * Latest inputs. The run loop is async and must not close over the product or
   * the tone as they were when the button was pressed three calls ago — the
   * classic stale-closure bug, which here would write a caption for the
   * previous product.
   */
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Bumped per run: answers from an older run are ignored, never applied. */
  const generationRef = useRef(0);

  const reset = useCallback(() => {
    generationRef.current += 1;
    setStatuses({});
    setErrors({});
    setDone(0);
    setTotal(0);
    setIsRunning(false);
  }, []);

  const run = useCallback((channelIds: readonly string[]) => {
    const plan = fanOutPlan(channelIds);
    // Edge cases first: nothing to write for, or nothing composed to write from.
    if (plan.channelIds.length === 0) return;
    const started = inputRef.current.content;
    if (!started) return;
    /** The product this run was pressed for — explicit, so the closures below
        keep it non-null however TypeScript feels about narrowing across them. */
    const startedWith: ProductContent = started;

    const generation = (generationRef.current += 1);
    setStatuses({});
    setErrors({});
    setDone(0);
    setTotal(plan.channelIds.length);
    setIsRunning(true);

    const isCurrent = () => mountedRef.current && generationRef.current === generation;

    /**
     * One call for one channel. The endpoint takes the PLATFORM catalogue, so
     * every call is the same request — the difference is which tab the answer
     * lands on, and that a fresh call produces a fresh variation.
     */
    async function generateOne(): Promise<{ text?: string; reason?: string }> {
      const result = await generateCaptions({
        // The product as it is NOW, falling back to the one the run started
        // with: a compose that failed mid-run nulls `content`, and finishing the
        // run for the product the operator actually pressed for is the honest
        // outcome.
        content: inputRef.current.content ?? startedWith,
        channels: COMPOSE_CHANNELS.map((channel) => channel.id),
        tone: inputRef.current.tone,
      });
      const platformId = COMPOSE_CHANNELS[0].id;
      const text = result.generated.find((item) => item.channelId === platformId)?.text;
      if (text) return { text };
      // A 200 with nothing usable is still a failure for this channel, and the
      // server names it in `failed`.
      return {
        reason: result.failed.find((item) => item.channelId === platformId)?.reason,
      };
    }

    void runCaptionFanOut({
      channelIds: plan.channelIds,
      concurrency: plan.concurrency,
      isCurrent,
      generate: () =>
        generateOne().catch((error: unknown) => {
          // Turned into this channel's reason by the loop; ApiError carries the
          // operator sentence the server wrote.
          throw ApiError.is(error) ? new Error(error.userMessage) : error;
        }),
      events: {
        onPending: (channelId) =>
          setStatuses((current) => ({ ...current, [channelId]: "pending" })),
        onText: (channelId, text) => {
          inputRef.current.onText(channelId, text);
          setStatuses((current) => ({ ...current, [channelId]: "done" }));
        },
        onError: (channelId, reason) => {
          setStatuses((current) => ({ ...current, [channelId]: "error" }));
          setErrors((current) => ({ ...current, [channelId]: reason }));
        },
        onSettled: () => setDone((current) => current + 1),
      },
    }).then(() => {
      if (!isCurrent()) return;
      setIsRunning(false);
      inputRef.current.onSettled?.();
    });
  }, []);

  return { statuses, errors, isRunning, done, total, run, reset };
}
