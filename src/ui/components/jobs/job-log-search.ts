import type { PostJobLogEntry } from "@/ui/schemas/post-batch.schema";

/**
 * The box above the log, as a rule rather than a closure.
 *
 * It searches the pages ALREADY LOADED — the list is keyset-paged, and no
 * endpoint takes a free-text query today. That is a real limitation, not a
 * detail: the screen must therefore say what it searched over, and must never
 * answer "không có bài nào khớp" as if it had seen the whole log. `JobLogScreen`
 * carries that sentence; this module owns which rows match.
 *
 * Fields are chosen from what an operator actually types when chasing a post:
 * the product code, the channel, the batch from a link, the message they read
 * on screen, and the error code they were given by support.
 */

/** Case-insensitive, whitespace-trimmed; an empty query matches everything. */
export function matchesJobSearch(job: PostJobLogEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return true;

  const haystacks = [
    job.productCode,
    job.channelId,
    job.batchId,
    job.userMessage,
    job.lastErrorCode ?? "",
  ];

  return haystacks.some((value) => value.toLowerCase().includes(query));
}

export function filterJobsBySearch(
  jobs: readonly PostJobLogEntry[],
  rawQuery: string,
): readonly PostJobLogEntry[] {
  if (rawQuery.trim().length === 0) return jobs;
  return jobs.filter((job) => matchesJobSearch(job, rawQuery));
}
