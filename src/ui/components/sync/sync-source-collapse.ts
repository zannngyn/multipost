import type { GoogleConnectionState } from "@/ui/schemas/google-drive.schema";
import type { SyncStatusResponse } from "@/ui/schemas/sync.schema";

/**
 * Whether "Nguồn đang đọc" may fold into a single summary row.
 *
 * The source is set-once configuration; on a normal morning it is ~400px of
 * settled facts standing between the operator and the run they came to read.
 * Folding it is worth real height — which is exactly why the decision lives
 * here, JSX-free, with a test per branch: every condition below is something an
 * operator must not have hidden from them (business rule 5).
 *
 * The load-bearing rule: **the pipeline, not the connection, is the evidence.**
 * A tenant reading Drive with a Service Account is permanently `not_connected`
 * and permanently fine — its last sync proves it. A tenant whose OAuth token
 * was revoked is `expired` and its next sync will fail. Judging by connection
 * state alone gets the first case wrong; judging by "did the last run work"
 * gets both right.
 */

/**
 * The verdict the pipeline gives about this tenant's setup. Only `healthy`
 * earns a fold — `unknown` (no answer yet) is deliberately not optimistic.
 */
export type LastRunHealth =
  | "unknown"
  | "never_run"
  | "in_flight"
  | "healthy"
  | "unhealthy";

/**
 * `partial` counts as healthy: the run walked Drive and the Sheet end to end
 * and wrote rows, which is the only thing this verdict is asked about. The
 * problems it found are reported in the main column — the very content the
 * folded card exists to lift above the fold.
 */
export function lastRunHealth(
  data: SyncStatusResponse | undefined,
  isError: boolean,
): LastRunHealth {
  // No answer is not a good answer. A failed or pending status query says
  // nothing about the setup, so it cannot license hiding the setup.
  if (isError || !data) return "unknown";
  if (data.state === "never_synced") return "never_run";

  switch (data.run.status) {
    case "running":
      return "in_flight";
    case "succeeded":
    case "partial":
      return "healthy";
    case "failed":
      return "unhealthy";
  }
}

export type SourceCollapseInput = {
  /** A Drive folder + Sheet tab are stored for this tenant. */
  hasConfiguredSource: boolean;
  isSourceLoading: boolean;
  isSourceError: boolean;
  isConnectionLoading: boolean;
  isConnectionError: boolean;
  /** Null while the status query has produced no payload. */
  connectionState: GoogleConnectionState | null;
  /** The stored source is not readable by the connected account. */
  hasSourceAccessWarning: boolean;
  /** A disconnect that failed — the token is still stored and nobody knows. */
  hasDisconnectError: boolean;
  /** The OAuth round-trip result is still on screen. */
  hasConnectOutcome: boolean;
  isPicking: boolean;
  isManualOpen: boolean;
  lastRunHealth: LastRunHealth;
};

export function canCollapseSourceCard(input: SourceCollapseInput): boolean {
  // Guard clauses in severity order. The full card is the default; the folded
  // row is the exception, and it has to clear every one of these.

  // Nothing stored, or neither query has settled: the card is the only place
  // that says so.
  if (!input.hasConfiguredSource) return false;
  if (input.isSourceLoading || input.isSourceError) return false;
  if (input.isConnectionLoading || input.isConnectionError) return false;
  if (input.connectionState === null) return false;

  /**
   * Stricter than the letter of the ruling, on purpose (see report): `expired`
   * is an affirmative statement that a stored credential broke, so the NEXT
   * sync fails no matter how well the last one went. `not_connected` carries no
   * such claim — it is the normal resting state of a Service Account tenant —
   * and is therefore no longer a blocker.
   */
  if (input.connectionState === "expired") return false;

  // The sentence that stops somebody pressing "Chạy đồng bộ" and wiping the
  // catalogue, and a failed disconnect that left a live token behind.
  if (input.hasSourceAccessWarning) return false;
  if (input.hasDisconnectError) return false;

  // Mid-flow: the answer from Google is still up, or an editor is open.
  if (input.hasConnectOutcome) return false;
  if (input.isPicking || input.isManualOpen) return false;

  // Finally, the evidence: only a run that finished and wrote proves the setup
  // works. "Never run", "still running" and "failed" all leave the card open.
  return input.lastRunHealth === "healthy";
}
