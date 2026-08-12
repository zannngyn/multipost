import { AppError } from "@/core/domain/errors";
import type { ChannelPublisher, PublishImagePostInput, PublishResult } from "@/core/ports/publisher";

import { mapGraphError, type GraphErrorBody } from "./graph-error-map";

/**
 * Scriptable ChannelPublisher for tests and the E7 smoke script.
 *
 * It exists because the publish flow (state machine, anti-duplicate lock, stock
 * recheck, spacing, retries) must be provable WITHOUT a Page token — and because
 * "how many times was the platform called?" is the only honest way to prove that
 * a blocked job never reached Facebook.
 *
 * Same failure vocabulary as the real adapter: every scripted error goes through
 * mapGraphError, so a test asserts on the codes production would produce.
 */

export interface FakePublishScenario {
  /** Fail this many calls with a transient error, then succeed. */
  readonly transientFailures?: number;
  /** Fail EVERY call with this Graph error body (e.g. { code: 190 }). */
  readonly graphError?: GraphErrorBody;
  /** Artificial latency, to make spacing/timing visible in the smoke script. */
  readonly delayMs?: number;
}

export interface FakePublishCall {
  readonly channelId: string;
  readonly pageId: string;
  readonly caption: string;
  readonly mediaCount: number;
  /** URLs handed over for THIS call — the proof they were re-signed (E3.6). */
  readonly mediaUrls: readonly string[];
  readonly idempotencyKey: string;
  readonly at: Date;
  readonly outcome: "published" | "error";
  readonly errorCode?: string;
}

export interface FakeChannelPublisher extends ChannelPublisher {
  readonly calls: readonly FakePublishCall[];
  callCount(channelId?: string): number;
  publishedCount(channelId?: string): number;
  setScenario(channelId: string, scenario: FakePublishScenario | null): void;
  reset(): void;
}

export function makeFakeChannelPublisher(options: {
  scenarios?: Readonly<Record<string, FakePublishScenario>>;
} = {}): FakeChannelPublisher {
  const scenarios = new Map<string, FakePublishScenario>(Object.entries(options.scenarios ?? {}));
  const failuresSoFar = new Map<string, number>();
  const calls: FakePublishCall[] = [];
  let sequence = 0;

  return {
    calls,
    callCount(channelId?: string): number {
      return channelId ? calls.filter((call) => call.channelId === channelId).length : calls.length;
    },
    publishedCount(channelId?: string): number {
      return calls.filter(
        (call) => call.outcome === "published" && (!channelId || call.channelId === channelId),
      ).length;
    },
    setScenario(channelId: string, scenario: FakePublishScenario | null): void {
      if (scenario) scenarios.set(channelId, scenario);
      else scenarios.delete(channelId);
      failuresSoFar.delete(channelId);
    },
    reset(): void {
      calls.length = 0;
      failuresSoFar.clear();
      sequence = 0;
    },

    async publishImagePost(input: PublishImagePostInput): Promise<PublishResult> {
      const channel = input?.channel;
      if (!channel) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Fake publisher called without a channel",
          context: { tenant_id: input?.tenantId ?? null },
        });
      }

      const scenario = scenarios.get(channel.channelId) ?? {};
      if (scenario.delayMs && scenario.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      }

      const record = (outcome: "published" | "error", errorCode?: string): void => {
        calls.push({
          channelId: channel.channelId,
          pageId: channel.externalId,
          caption: input.caption,
          mediaCount: input.media?.length ?? 0,
          mediaUrls: (input.media ?? []).map((item) => item.url),
          idempotencyKey: input.idempotencyKey,
          at: new Date(),
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      };

      if (scenario.graphError) {
        const error = mapGraphError({
          error: scenario.graphError,
          httpStatus: 400,
          context: { tenant_id: input.tenantId, channel: channel.channelId, fake: true },
        });
        record("error", error.code);
        throw error;
      }

      const budget = scenario.transientFailures ?? 0;
      const failed = failuresSoFar.get(channel.channelId) ?? 0;
      if (failed < budget) {
        failuresSoFar.set(channel.channelId, failed + 1);
        // Graph code 2 = temporary platform problem -> retryable META_ERROR.
        const error = mapGraphError({
          error: { code: 2, message: "Fake transient Graph failure" },
          httpStatus: 500,
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            fake: true,
            failure_number: failed + 1,
            failure_budget: budget,
          },
        });
        record("error", error.code);
        throw error;
      }

      sequence += 1;
      const postId = `${channel.externalId}_${1000 + sequence}`;
      record("published");
      return { postId, url: `https://www.facebook.com/${postId}` };
    },
  };
}
