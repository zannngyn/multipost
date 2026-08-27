import { describe, expect, it } from "vitest";

import {
  canCollapseSourceCard,
  lastRunHealth,
  type SourceCollapseInput,
} from "@/ui/components/sync/sync-source-collapse";
import type { SyncRun, SyncRunStatus, SyncStatusResponse } from "@/ui/schemas/sync.schema";

function makeRun(status: SyncRunStatus): SyncRun {
  return {
    tenantId: "tenant-1",
    syncRunId: "run-1",
    status,
    startedAt: "2026-08-22T03:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-08-22T03:04:12.000Z",
    counts: null,
    issues: [],
    issueGroups: null,
    errorCode: null,
    errorMessage: null,
    recentRuns: [],
  };
}

function hasRun(status: SyncRunStatus): SyncStatusResponse {
  return { state: "has_run", run: makeRun(status) };
}

/** Everything settled and healthy — each test breaks exactly one thing. */
function baseInput(overrides: Partial<SourceCollapseInput> = {}): SourceCollapseInput {
  return {
    hasConfiguredSource: true,
    isSourceLoading: false,
    isSourceError: false,
    isConnectionLoading: false,
    isConnectionError: false,
    connectionState: "connected",
    hasSourceAccessWarning: false,
    hasDisconnectError: false,
    hasConnectOutcome: false,
    isPicking: false,
    isManualOpen: false,
    lastRunHealth: "healthy",
    ...overrides,
  };
}

describe("lastRunHealth", () => {
  it("gives no verdict while the status query has no payload", () => {
    expect(lastRunHealth(undefined, false)).toBe("unknown");
  });

  it("gives no verdict when the status query failed", () => {
    // A failed status read says nothing about the setup, so it must not be
    // allowed to license hiding the setup.
    expect(lastRunHealth(hasRun("succeeded"), true)).toBe("unknown");
  });

  it("separates 'never synced' from every other answer", () => {
    expect(lastRunHealth({ state: "never_synced", tenantId: "tenant-1" }, false)).toBe("never_run");
  });

  it("reads a run still in flight as in_flight, not healthy", () => {
    expect(lastRunHealth(hasRun("running"), false)).toBe("in_flight");
  });

  it("counts succeeded and partial as healthy — both walked the source end to end", () => {
    expect(lastRunHealth(hasRun("succeeded"), false)).toBe("healthy");
    expect(lastRunHealth(hasRun("partial"), false)).toBe("healthy");
  });

  it("counts a failed run as unhealthy", () => {
    expect(lastRunHealth(hasRun("failed"), false)).toBe("unhealthy");
  });
});

describe("canCollapseSourceCard — the pipeline is the evidence (I-1)", () => {
  it("folds for a Service Account tenant: never connected, but the last sync worked", () => {
    // The case the old connection-state rule got wrong — `not_connected` is
    // this tenant's permanent, correct resting state.
    expect(
      canCollapseSourceCard(baseInput({ connectionState: "not_connected" })),
    ).toBe(true);
  });

  it("keeps the card open when the token was revoked and the sync fails", () => {
    expect(
      canCollapseSourceCard(
        baseInput({ connectionState: "expired", lastRunHealth: "unhealthy" }),
      ),
    ).toBe(false);
  });

  it("keeps the card open when the tenant has never synced", () => {
    expect(canCollapseSourceCard(baseInput({ lastRunHealth: "never_run" }))).toBe(false);
    expect(
      canCollapseSourceCard(
        baseInput({ connectionState: "not_connected", lastRunHealth: "never_run" }),
      ),
    ).toBe(false);
  });

  it("keeps the card open when the last run FAILED and nothing else is wrong (B-3)", () => {
    // The gap this closes: `unhealthy` was only ever asserted next to an
    // `expired` connection, and that guard returns first — so the final
    // `=== "healthy"` was never the line under test. A tenant whose sync just
    // failed, on a connection that still looks fine, is exactly whose
    // configuration must stay on screen.
    expect(canCollapseSourceCard(baseInput({ lastRunHealth: "unhealthy" }))).toBe(false);
    expect(
      canCollapseSourceCard(
        baseInput({ connectionState: "not_connected", lastRunHealth: "unhealthy" }),
      ),
    ).toBe(false);
  });

  it("keeps the card open while a sync is still in flight", () => {
    expect(canCollapseSourceCard(baseInput({ lastRunHealth: "in_flight" }))).toBe(false);
  });

  it("keeps the card open when there is no verdict at all", () => {
    expect(canCollapseSourceCard(baseInput({ lastRunHealth: "unknown" }))).toBe(false);
  });

  it("keeps the card open for an expired connection even when the last run was healthy", () => {
    // Deliberately stricter than the letter of the ruling: `expired` says a
    // stored credential broke, so the NEXT sync fails however well the last
    // one went. Delete this branch (and its guard) to follow the ruling
    // literally.
    expect(canCollapseSourceCard(baseInput({ connectionState: "expired" }))).toBe(false);
  });
});

describe("canCollapseSourceCard — nothing that needs attention may be hidden", () => {
  it("refuses when no source is stored", () => {
    expect(canCollapseSourceCard(baseInput({ hasConfiguredSource: false }))).toBe(false);
  });

  it("refuses while either query is still loading", () => {
    expect(canCollapseSourceCard(baseInput({ isSourceLoading: true }))).toBe(false);
    expect(canCollapseSourceCard(baseInput({ isConnectionLoading: true }))).toBe(false);
  });

  it("refuses when either query failed", () => {
    expect(canCollapseSourceCard(baseInput({ isSourceError: true }))).toBe(false);
    expect(canCollapseSourceCard(baseInput({ isConnectionError: true }))).toBe(false);
  });

  it("refuses when the connection status produced no payload", () => {
    expect(canCollapseSourceCard(baseInput({ connectionState: null }))).toBe(false);
  });

  it("refuses when the stored source is not readable by the account", () => {
    expect(canCollapseSourceCard(baseInput({ hasSourceAccessWarning: true }))).toBe(false);
  });

  it("refuses after a failed disconnect — the token is still stored (I-2)", () => {
    expect(canCollapseSourceCard(baseInput({ hasDisconnectError: true }))).toBe(false);
  });

  it("refuses while the OAuth result is still on screen", () => {
    expect(canCollapseSourceCard(baseInput({ hasConnectOutcome: true }))).toBe(false);
  });

  it("refuses while an editor is open", () => {
    expect(canCollapseSourceCard(baseInput({ isPicking: true }))).toBe(false);
    expect(canCollapseSourceCard(baseInput({ isManualOpen: true }))).toBe(false);
  });

  it("folds only when every condition is clear at once", () => {
    expect(canCollapseSourceCard(baseInput())).toBe(true);
  });
});
