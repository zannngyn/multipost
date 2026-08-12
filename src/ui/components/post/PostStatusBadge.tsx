import { Badge } from "@/ui/components/ui/badge";
import {
  POST_BATCH_STATUS_LABELS,
  POST_BATCH_STATUS_TONES,
  POST_JOB_STATUS_LABELS,
  POST_JOB_STATUS_TONES,
  type PostBatchStatus,
  type PostJobStatus,
} from "@/ui/schemas/post-batch.schema";

/**
 * The ONE place a post_job / post_batch status becomes a coloured pill
 * (core-component-reuse): the batch screen and the job log must never disagree
 * about what "blocked" looks like or is called.
 *
 * The label is always rendered as text — colour alone never carries the
 * meaning (core-accessibility).
 */

export function JobStatusBadge({ status }: { status: PostJobStatus }) {
  return <Badge tone={POST_JOB_STATUS_TONES[status]}>{POST_JOB_STATUS_LABELS[status]}</Badge>;
}

export function BatchStatusBadge({ status }: { status: PostBatchStatus }) {
  return <Badge tone={POST_BATCH_STATUS_TONES[status]}>{POST_BATCH_STATUS_LABELS[status]}</Badge>;
}
