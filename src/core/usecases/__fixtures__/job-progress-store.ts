import { AppError } from "@/core/domain/errors";
import type { PostJobProgress } from "@/core/domain/post-job-progress";
import type { JobProgressStore, ReportProgressInput } from "@/core/ports/job-progress";

/**
 * In-memory JobProgressStore for tests (E7.5).
 *
 * It records the FULL sequence, not just the latest value: "which steps did the
 * operator see, in which order" is the thing worth asserting, and a store that
 * only kept the last one would pass while the flow skipped three stages.
 */
export interface MemoryJobProgressStore extends JobProgressStore {
  /** Every report, in order. */
  readonly reports: readonly ReportProgressInput[];
  /** Stage of every report, in order — the assertion most tests want. */
  stages(): readonly string[];
  readonly cleared: readonly string[];
  latest(postJobId: string): PostJobProgress | undefined;
  reset(): void;
}

export function makeMemoryJobProgressStore(): MemoryJobProgressStore {
  const reports: ReportProgressInput[] = [];
  const cleared: string[] = [];
  const current = new Map<string, PostJobProgress>();

  return {
    reports,
    cleared,
    stages: () => reports.map((entry) => entry.progress.stage),
    latest: (postJobId: string) => current.get(postJobId),
    reset(): void {
      reports.length = 0;
      cleared.length = 0;
      current.clear();
    },
    async report(input: ReportProgressInput): Promise<void> {
      reports.push(input);
      current.set(input.postJobId, input.progress);
    },
    async read(_tenantId: string, postJobIds: readonly string[]) {
      const map = new Map<string, PostJobProgress>();
      for (const id of postJobIds) {
        const progress = current.get(id);
        if (progress) map.set(id, progress);
      }
      return map;
    },
    async clear(_tenantId: string, postJobId: string): Promise<void> {
      cleared.push(postJobId);
      current.delete(postJobId);
    },
  };
}

/**
 * A store that breaks its own contract and throws on every call.
 *
 * The port says `report`/`clear` never throw; this fake exists to prove the
 * usecase does not TRUST that promise (design §3.3): a post must go out even
 * when its telemetry is broken in a way nobody planned for.
 */
export function makeThrowingJobProgressStore(): JobProgressStore {
  const boom = (operation: string): never => {
    throw new AppError("QUEUE_ERROR", {
      message: `Progress store is down (${operation})`,
      context: { operation },
    });
  };
  return {
    async report() {
      return boom("report");
    },
    async read() {
      return boom("read");
    },
    async clear() {
      return boom("clear");
    },
  };
}
