/**
 * E7.5 — where the live progress of a running post job is kept.
 *
 * Pure TypeScript: types only (docs/07 §2). The adapter (Redis) decides TTL,
 * keys and encoding; core only says what it needs.
 *
 * THE WHOLE PORT IS BEST-EFFORT (design §3.1): `post_job.status` in Postgres is
 * the truth, this is decoration on top of it. Everything here may be missing,
 * stale, or gone — a reader that cannot live with that is reading the wrong
 * source.
 */

import type { PostJobProgress } from "@/core/domain/post-job-progress";
import type { TenantId } from "@/core/domain/tenant-context";

export interface ReportProgressInput {
  readonly tenantId: TenantId;
  readonly postJobId: string;
  readonly progress: PostJobProgress;
}

export interface JobProgressStore {
  /**
   * Stores the current progress of one job.
   *
   * MUST NOT THROW — ever, for any input, including a store that is down.
   *
   * DELIBERATE EXCEPTION to technical standard #5 (design §5.2, approved by the
   * PM): the implementer logs `warn` with full context (tenant_id, post_job_id,
   * stage, error code, stack) and returns. It does NOT rethrow, and there is no
   * entity to move to a failed state either — this is telemetry. Rethrowing
   * would turn one blocked Redis write into one post that did not go out, i.e.
   * trade the important thing for the unimportant one.
   *
   * The exception covers `report` and `clear` on this port and nothing else.
   * `read` below is not allowed to throw for a different reason (a screen must
   * not break because a decoration is missing), and it says so itself.
   */
  report(input: ReportProgressInput): Promise<void>;

  /**
   * Progress of the given jobs, keyed by post job id. A job with no entry is
   * simply absent from the map: "no progress" is a normal answer, not an error.
   * A failing store yields an EMPTY map plus a warn — never a throw.
   */
  read(
    tenantId: TenantId,
    postJobIds: readonly string[],
  ): Promise<ReadonlyMap<string, PostJobProgress>>;

  /**
   * Drops the entry of a job that has finished (published / blocked / failed),
   * so a dead key does not survive to its TTL and describe a job that is over.
   * Same no-throw contract as `report`.
   */
  clear(tenantId: TenantId, postJobId: string): Promise<void>;
}
