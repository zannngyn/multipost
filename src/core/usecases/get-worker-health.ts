import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { QueueWorkerRegistry } from "@/core/ports/job-queue";
import type { UntouchedQueuedRepo } from "@/core/ports/post-job-repo";

/**
 * E11 — "có ai đang xử lý hàng đợi không?".
 *
 * The failure this exists for: an operator posts, nothing happens for twenty
 * minutes, and NOTHING anywhere says why — the job sits `queued` with
 * `attempt_count = 0`, no error code, because no worker process is running. The
 * queue had a producer and no consumer, and silence was the whole bug.
 *
 * The signal comes from the BROKER's own worker registry, not from a heartbeat
 * file: web and worker are separate containers, so a file on the worker's disk
 * is invisible to the screen that must show the warning.
 *
 * THIS USECASE NEVER THROWS — the single deliberate exception to "cấm nuốt lỗi"
 * (CLAUDE.md technical rule 5) in this file, and the reason is the whole point:
 * a dead Redis is exactly what it has to REPORT, so throwing would break the
 * /jobs screen at the one moment its banner matters. Every swallowed failure is
 * logged with context AND surfaced in the returned value (`queueReachable`,
 * a zero count), so nothing becomes invisible — it changes WHERE the operator
 * sees the problem, not whether they see it.
 *
 * Read-only and advisory: no publish decision may depend on these numbers (see
 * QueueWorkerCensus in the port).
 */

export interface WorkerHealthInput {
  readonly tenantId: string;
}

export interface WorkerHealth {
  /** Số worker đang nối vào hàng đợi. 0 = không ai xử lý job. */
  readonly workersOnline: number;
  /** false khi không hỏi được broker — bản thân nó cũng là một cảnh báo. */
  readonly queueReachable: boolean;
  /** Job `queued` của tenant này chưa từng được thử (attempt_count = 0). */
  readonly untouchedQueuedJobs: number;
  /** Job chưa được thử lâu nhất đã chờ bao nhiêu mili giây; null khi không có. */
  readonly oldestUntouchedWaitMs: number | null;
  readonly checkedAt: Date;
}

export interface GetWorkerHealthDeps {
  /** Broker-side consumer registry (BullMQ `getWorkers` behind the port). */
  workers: QueueWorkerRegistry;
  /** Narrow read port: only the untouched-queued counter. */
  postJobs: UntouchedQueuedRepo;
  clock: Clock;
  logger: Logger;
}

export function makeGetWorkerHealth(deps: GetWorkerHealthDeps) {
  return async function getWorkerHealth(input: WorkerHealthInput): Promise<WorkerHealth> {
    const checkedAt = deps.clock.now();
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";

    // --- Edge case: malformed tenant -------------------------------------
    // Still probe the queue (that half is tenant-independent and is the part
    // that answers "is anybody consuming?"), but do not invent job counts.
    const tenantOk = isTenantId(tenantId);
    if (!tenantOk) {
      deps.logger.warn("Worker health asked without a valid tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId || null,
      });
    }

    const log = deps.logger.child({ tenant_id: tenantOk ? tenantId : "unknown" });

    // --- Broker side ------------------------------------------------------
    let workersOnline = 0;
    let queueReachable = false;
    try {
      const census = await deps.workers.countWorkers();
      // The census crosses a port boundary: do not trust its shape. A garbage
      // count must read as "unknown", never as a fabricated number of workers.
      const raw = census?.workersOnline;
      const usable = typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
      if (census?.reachable === true && usable) {
        workersOnline = Math.floor(raw);
        queueReachable = true;
      } else if (census?.reachable === true) {
        log.warn("Queue reported an unusable worker count — treating it as unknown", {
          error_code: "QUEUE_ERROR",
          workers_online_raw: raw ?? null,
        });
      }
    } catch (error) {
      // The adapter promises not to throw; a custom/faulty one might. Swallowed
      // ON PURPOSE (see the header) and reported through queueReachable=false.
      log.warn("Could not ask the queue how many workers are online", {
        err: error,
        error_code: "QUEUE_ERROR",
        reason: "WORKER_CENSUS_FAILED",
      });
    }

    // --- Database side ----------------------------------------------------
    let untouchedQueuedJobs = 0;
    let oldestUntouchedWaitMs: number | null = null;
    if (tenantOk) {
      try {
        const untouched = await deps.postJobs.countUntouchedQueued({ tenantId, now: checkedAt });
        const total = untouched?.count;
        untouchedQueuedJobs =
          typeof total === "number" && Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
        const waitingSince = untouched?.oldestWaitingSince;
        if (untouchedQueuedJobs > 0 && waitingSince instanceof Date) {
          // Clamp: a row written by a host with a skewed clock must not produce
          // a negative "đã chờ" on the screen.
          oldestUntouchedWaitMs = Math.max(0, checkedAt.getTime() - waitingSince.getTime());
        }
      } catch (error) {
        // Same deliberate exception: a DB blip must not blank the banner that
        // says "không có worker nào chạy".
        log.warn("Could not count untouched queued jobs — reporting 0", {
          err: error,
          error_code: "DB_ERROR",
          reason: "UNTOUCHED_QUEUED_COUNT_FAILED",
        });
      }
    }

    // --- Verdict ----------------------------------------------------------
    // Symptomatic = jobs are waiting AND nobody seems to be consuming them (or
    // we cannot even ask). Logged at warn so the outage is in the worker log
    // too, not only on the screen someone has to be looking at.
    const symptomatic = untouchedQueuedJobs > 0 && (!queueReachable || workersOnline === 0);
    const line = {
      workers_online: workersOnline,
      queue_reachable: queueReachable,
      untouched_queued_jobs: untouchedQueuedJobs,
      oldest_untouched_wait_ms: oldestUntouchedWaitMs,
    };
    if (symptomatic) {
      log.warn("Jobs are queued but no worker seems to be consuming them", line);
    } else {
      log.debug("Worker health checked", line);
    }

    return {
      workersOnline,
      queueReachable,
      untouchedQueuedJobs,
      oldestUntouchedWaitMs,
      checkedAt,
    };
  };
}

export type GetWorkerHealth = ReturnType<typeof makeGetWorkerHealth>;
