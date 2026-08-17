import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { POST_JOB_STAGES, type PostJobProgress } from "@/core/domain/post-job-progress";
import type { Logger } from "@/core/ports/infra";
import type { JobProgressStore, ReportProgressInput } from "@/core/ports/job-progress";

/**
 * E7.5 — live job progress in Redis (design §5.3).
 *
 * Redis and not Postgres because of the write shape: ~15 updates per post, one
 * per photo, on a row a worker is holding. The durable half is the append-only
 * `post_job_event` table; this is the hot copy the tracking screen polls, and it
 * is allowed to disappear (design §3.1).
 *
 * The connection is passed IN, never opened here: the worker keeps one ioredis
 * connection for the queue and this store (design §5.3).
 */

/** One hour: long enough for the slowest album, short enough to self-clean. */
export const PROGRESS_TTL_SECONDS = 3600;

const KEY_PREFIX = "mysp:progress";

/**
 * The three commands this store uses, as a structural type instead of the full
 * ioredis surface: a test can implement it in five lines, and a real `Redis`
 * satisfies it as is.
 */
export interface ProgressRedisClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  del(...keys: string[]): Promise<number>;
}

export interface RedisJobProgressDeps {
  connection: ProgressRedisClient;
  logger: Logger;
  /** Override only for tests that want to watch a key expire. */
  ttlSeconds?: number;
}

/**
 * REDIS IS EXTERNAL DATA (technical standard #2): everything read back goes
 * through this schema before anything touches it. A key written by an older
 * worker, a half-written value, a stage this build does not know — all of them
 * are DROPPED with a warn, never patched up with defaults. A wrong step on the
 * stepper is worse than no stepper.
 */
const StoredProgressSchema = z.object({
  v: z.literal(1),
  stage: z.enum(POST_JOB_STAGES),
  attempt: z.number().int().min(0),
  done_count: z.number().int().min(0).nullable(),
  total_count: z.number().int().min(0).nullable(),
  current_item: z.string().nullable(),
  stage_started_at: z.string().min(1),
  wait_until: z.string().min(1).nullable(),
  updated_at: z.string().min(1),
});

type StoredProgress = z.infer<typeof StoredProgressSchema>;

export function makeRedisJobProgressStore(deps: RedisJobProgressDeps): JobProgressStore {
  const logger = deps.logger.child({ component: "redis-job-progress" });
  const ttlSeconds =
    typeof deps.ttlSeconds === "number" && Number.isInteger(deps.ttlSeconds) && deps.ttlSeconds > 0
      ? deps.ttlSeconds
      : PROGRESS_TTL_SECONDS;

  return {
    async report(input: ReportProgressInput): Promise<void> {
      // --- Edge cases first --------------------------------------------------
      const tenantId = str(input?.tenantId);
      const postJobId = str(input?.postJobId);
      const progress = input?.progress;
      if (tenantId.length === 0 || postJobId.length === 0 || !progress) {
        logger.warn("Progress report ignored: missing identity", {
          tenant_id: tenantId || null,
          post_job_id: postJobId || null,
          stage: progress?.stage ?? null,
          reason: "PROGRESS_REPORT_WITHOUT_IDENTITY",
        });
        return;
      }

      try {
        await deps.connection.set(
          keyOf(tenantId, postJobId),
          JSON.stringify(encode(progress)),
          "EX",
          ttlSeconds,
        );
      } catch (error) {
        // DELIBERATE, PM-APPROVED EXCEPTION to technical standard #5 (design
        // §5.2). Full context is logged, and the error stops HERE: a Redis blip
        // must not turn into a post that never went out. There is no entity to
        // move to a failed state either — this write is telemetry, not state.
        // Scope of the exception: this method and `clear` below, nothing else.
        logger.warn("Could not store job progress — the post is unaffected", {
          err: AppError.from(error, "QUEUE_ERROR", {
            tenant_id: tenantId,
            post_job_id: postJobId,
            stage: progress.stage,
            operation: "jobProgress.report",
          }),
          tenant_id: tenantId,
          post_job_id: postJobId,
          stage: progress.stage,
          error_code: "QUEUE_ERROR",
        });
      }
    },

    async read(
      tenantId: string,
      postJobIds: readonly string[],
    ): Promise<ReadonlyMap<string, PostJobProgress>> {
      const result = new Map<string, PostJobProgress>();

      // --- Edge cases first --------------------------------------------------
      const tenant = str(tenantId);
      const ids = Array.isArray(postJobIds)
        ? [...new Set(postJobIds.map(str).filter((id) => id.length > 0))]
        : [];
      // No round trip for an empty batch: MGET with no key is an error in Redis.
      if (tenant.length === 0 || ids.length === 0) return result;

      let values: (string | null)[];
      try {
        values = await deps.connection.mget(...ids.map((id) => keyOf(tenant, id)));
      } catch (error) {
        // The screen keeps every status column it had; only the decoration is
        // missing (design §5.7). Logged, not thrown: a dead Redis must not turn
        // the tracking screen into an error page.
        logger.warn("Could not read job progress — the screen falls back to status only", {
          err: AppError.from(error, "QUEUE_ERROR", {
            tenant_id: tenant,
            post_job_count: ids.length,
            operation: "jobProgress.read",
          }),
          tenant_id: tenant,
          post_job_count: ids.length,
          error_code: "QUEUE_ERROR",
        });
        return result;
      }

      const list = Array.isArray(values) ? values : [];
      ids.forEach((postJobId, index) => {
        const raw = list[index];
        if (typeof raw !== "string" || raw.length === 0) return; // no key = no progress
        const decoded = decode(raw, { tenantId: tenant, postJobId }, logger);
        if (decoded) result.set(postJobId, decoded);
      });
      return result;
    },

    async clear(tenantId: string, postJobId: string): Promise<void> {
      const tenant = str(tenantId);
      const jobId = str(postJobId);
      if (tenant.length === 0 || jobId.length === 0) {
        logger.warn("Progress clear ignored: missing identity", {
          tenant_id: tenant || null,
          post_job_id: jobId || null,
          reason: "PROGRESS_CLEAR_WITHOUT_IDENTITY",
        });
        return;
      }

      try {
        await deps.connection.del(keyOf(tenant, jobId));
      } catch (error) {
        // Same deliberate exception as `report` (design §5.2). A key that could
        // not be deleted expires on its own within the TTL, and the reading
        // usecase hides it anyway once the job leaves queued/publishing (§3.1).
        logger.warn("Could not clear job progress — the key will expire by itself", {
          err: AppError.from(error, "QUEUE_ERROR", {
            tenant_id: tenant,
            post_job_id: jobId,
            operation: "jobProgress.clear",
          }),
          tenant_id: tenant,
          post_job_id: jobId,
          error_code: "QUEUE_ERROR",
          ttl_seconds: ttlSeconds,
        });
      }
    },
  };
}

/** `mysp:progress:{tenantId}:{postJobId}` (design §5.3). */
export function progressKey(tenantId: string, postJobId: string): string {
  return keyOf(str(tenantId), str(postJobId));
}

function keyOf(tenantId: string, postJobId: string): string {
  return `${KEY_PREFIX}:${tenantId}:${postJobId}`;
}

/** snake_case + ISO strings: the value is read by tools other than this build. */
function encode(progress: PostJobProgress): StoredProgress {
  return {
    v: 1,
    stage: progress.stage,
    attempt: progress.attempt,
    done_count: progress.doneCount,
    total_count: progress.totalCount,
    current_item: progress.currentItem,
    stage_started_at: isoOf(progress.stageStartedAt) ?? new Date(0).toISOString(),
    wait_until: isoOf(progress.waitUntil),
    updated_at: isoOf(progress.updatedAt) ?? new Date(0).toISOString(),
  };
}

/**
 * One stored value -> domain, or null. Null means "this key tells us nothing
 * usable", and the caller treats it exactly like a missing key.
 */
function decode(
  raw: string,
  ids: { tenantId: string; postJobId: string },
  logger: Logger,
): PostJobProgress | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    logger.warn("Dropped a job progress entry: the stored value is not JSON", {
      err: AppError.from(error, "INVALID_INPUT", { ...snake(ids), reason: "PROGRESS_JSON_BROKEN" }),
      ...snake(ids),
      error_code: "INVALID_INPUT",
      reason: "PROGRESS_JSON_BROKEN",
      value_length: raw.length,
    });
    return null;
  }

  const parsed = StoredProgressSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.warn("Dropped a job progress entry: the stored value failed validation", {
      ...snake(ids),
      error_code: "INVALID_INPUT",
      reason: "PROGRESS_SCHEMA_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return null;
  }

  const stageStartedAt = dateOf(parsed.data.stage_started_at);
  const updatedAt = dateOf(parsed.data.updated_at);
  if (!stageStartedAt || !updatedAt) {
    logger.warn("Dropped a job progress entry: unreadable timestamps", {
      ...snake(ids),
      error_code: "INVALID_INPUT",
      reason: "PROGRESS_TIMESTAMP_INVALID",
      stage: parsed.data.stage,
    });
    return null;
  }
  // A broken `wait_until` drops the COUNTDOWN, not the whole entry: the stage
  // and the counts are still true, and showing them without a countdown beats
  // showing nothing (design §3.2 — never invent one either).
  const waitUntil = parsed.data.wait_until ? dateOf(parsed.data.wait_until) : null;

  return {
    stage: parsed.data.stage,
    attempt: parsed.data.attempt,
    doneCount: parsed.data.done_count,
    totalCount: parsed.data.total_count,
    currentItem: parsed.data.current_item,
    stageStartedAt,
    waitUntil,
    updatedAt,
  };
}

function snake(ids: { tenantId: string; postJobId: string }): Record<string, string> {
  return { tenant_id: ids.tenantId, post_job_id: ids.postJobId };
}

function isoOf(value: Date | null): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

function dateOf(value: string): Date | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
