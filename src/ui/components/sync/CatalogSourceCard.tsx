"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { CatalogSourceForm } from "@/ui/components/sync/CatalogSourceForm";
import { GoogleConnectionPanel } from "@/ui/components/sync/GoogleConnectionPanel";
import { GoogleDrivePicker } from "@/ui/components/sync/GoogleDrivePicker";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useCatalogSource } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { useDisconnectGoogle, useGoogleConnection } from "@/ui/hooks/useGoogleDrive";
import {
  canCollapseSourceCard,
  type LastRunHealth,
} from "@/ui/components/sync/sync-source-collapse";
import { shortenId, type CatalogSource } from "@/ui/schemas/catalog.schema";
import {
  parseGoogleConnectOutcome,
  sourceAccessWarning,
  type GoogleConnectOutcome,
} from "@/ui/schemas/google-drive.schema";

/**
 * "Nguồn đang đọc" — WHICH Drive folder and WHICH Sheet tab this tenant reads,
 * and HOW the tool is allowed to read them.
 *
 * The card is stacked in the order an operator sets things up:
 *  1. the Google connection (primary — connect once, then pick in-app);
 *  2. the source itself (facts, or the in-app picker while choosing);
 *  3. "Hoặc nhập link/ID thủ công" — the fallback for a tenant that runs on a
 *     Service Account and never connects OAuth. It is collapsed, never removed:
 *     it is the ONLY way in when the connection is not there, so it opens by
 *     itself when no source is stored, and a "Đổi nguồn" button in the header
 *     opens it when one already is. Without that button the same tenant would
 *     have to guess that a summary it never opened hides its only editor.
 *
 * Four states per region: loading (skeleton) / data / empty (chưa cấu hình) /
 * error. The connection and the source are separate queries on purpose — one
 * failing must not blank the other.
 *
 * On top of those, the card has a SIZE: once a source is stored and the last
 * sync proves it works, the whole thing folds into one summary row so the run's
 * numbers are not pushed under the fold by settled configuration. The rule for
 * that — and every condition that keeps the card open — lives in
 * `sync-source-collapse.ts`, tested per branch.
 */
export function CatalogSourceCard({
  lastRunHealth,
  onSourceChanged,
}: {
  /**
   * The pipeline's verdict on this setup, from the sync-status query the screen
   * already runs. It is the evidence the fold is allowed on: connection state
   * alone calls a healthy Service Account tenant "chưa kết nối" forever, and
   * cannot tell that apart from a setup that is quietly broken.
   */
  lastRunHealth: LastRunHealth;
  /** Lets the screen point at "Chạy đồng bộ" right after a source change. */
  onSourceChanged?: () => void;
}) {
  const baseId = useId();
  const headingId = `${baseId}-source`;
  // Lifted out of the disclosure: the "Đổi nguồn" button in the header points
  // at the SAME panel, so both controls need the id.
  const manualPanelId = `${baseId}-manual`;
  /** The whole card body, so the collapsed row's button can point at it. */
  const detailsId = `${baseId}-details`;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const source = useCatalogSource();
  const connection = useGoogleConnection();
  /**
   * Hoisted out of `GoogleConnectionPanel` (I-2): that panel is unmounted the
   * moment the card folds, and a disconnect that failed left a live token
   * stored. Both the mutation state and its notice belong to the card, which
   * survives the fold.
   */
  const disconnect = useDisconnectGoogle();

  /**
   * Support mode is read-only (M3.3). Changing the source is the heaviest write
   * on this screen — the next sync deletes every product that no longer belongs
   * to the new folder — so the picker, the manual form and the button that
   * opens them all go off together.
   */
  const gate = writeGate(useReadOnlyReason());

  const [isPicking, setIsPicking] = useState(false);
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [hasAutoOpenedManual, setHasAutoOpenedManual] = useState(false);
  /**
   * Operator intent, not a derived value: once this card is opened it STAYS
   * open until the operator closes it or a source change completes. Deriving it
   * would collapse the card underneath somebody mid-task — e.g. the moment a
   * disconnect succeeds, or the moment an OAuth banner is dismissed.
   */
  const [isExpanded, setIsExpanded] = useState(false);

  // --- OAuth callback: `?google=connected|cancelled|error&reason=…` ---------
  const search = searchParams.toString();
  const [lastReadSearch, setLastReadSearch] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GoogleConnectOutcome | null>(null);

  // Adjusting state during render (the documented React alternative to an
  // effect): the callback is read ONCE, and its message has to survive the URL
  // rewrite below — reading it straight from `searchParams` would make the
  // notice vanish the moment the params are wiped.
  if (lastReadSearch !== search) {
    setLastReadSearch(search);
    const parsed = parseGoogleConnectOutcome(new URLSearchParams(search));
    if (parsed) {
      setOutcome(parsed);
      // Coming back from Google IS the source-setup flow. The card has to be
      // open to show what the round trip produced — and it must stay open after
      // the banner is dismissed, or the answer would take the card with it.
      setIsExpanded(true);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (parseGoogleConnectOutcome(params) === null) return;

    // Drop only the callback params — anything else in the URL belongs to
    // another feature. The message now lives in state, and a reload must not
    // resurrect "Đã kết nối Google" hours later.
    params.delete("google");
    params.delete("reason");
    const rest = params.toString();
    router.replace(rest.length > 0 ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [search, pathname, router]);

  const isFirstLoad = source.isPending && source.fetchStatus === "fetching";
  /**
   * The status query is still in flight — so "đã kết nối hay chưa" has NO
   * answer yet, and `connection.data?.state ?? null` must not be read as "no".
   * Every conclusion drawn from it waits for this to be false.
   */
  const isConnectionFirstLoad = connection.isPending && connection.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad || isConnectionFirstLoad);
  const configured = source.data?.state === "configured" ? source.data.source : null;
  const connectionState = connection.data?.state ?? null;
  const isConnected = connectionState === "connected";

  /**
   * A tenant that reads Drive with a Service Account never connects OAuth, so
   * the picker is not for it — the manual link/ID form is its ONLY way to change
   * a source it already has. It stays a secondary, outline action next to the
   * heading: connecting Google is still the primary route for everyone else.
   */
  const needsManualEntry = !isConnectionFirstLoad && !isConnected;

  /**
   * No source, and no working connection to build one with: the manual form is
   * the only way out, so it starts open instead of hiding behind a summary the
   * operator has no reason to suspect.
   */
  const shouldAutoOpenManual =
    configured === null &&
    !isFirstLoad &&
    (connection.isError || (connectionState !== null && connectionState !== "connected"));

  if (!hasAutoOpenedManual && shouldAutoOpenManual) {
    setHasAutoOpenedManual(true);
    setIsManualOpen(true);
  }

  function finishSourceChange() {
    setIsPicking(false);
    setIsManualOpen(false);
    // The change is done and the facts are settled — back to one line.
    setIsExpanded(false);
    onSourceChanged?.();
  }

  // The decision itself is pure and lives in `sync-source-collapse.ts`; this is
  // only the translation from query state into its inputs.
  const connectionData = connection.data ?? null;
  const sourceWarning =
    connectionData?.state === "connected" && connectionData.sourceAccess
      ? sourceAccessWarning(connectionData.sourceAccess)
      : null;
  const canCollapse = canCollapseSourceCard({
    hasConfiguredSource: configured !== null,
    isSourceLoading: isFirstLoad,
    isSourceError: source.isError,
    isConnectionLoading: isConnectionFirstLoad,
    isConnectionError: connection.isError,
    connectionState: connectionData?.state ?? null,
    hasSourceAccessWarning: sourceWarning !== null,
    hasDisconnectError: disconnect.isError,
    hasConnectOutcome: outcome !== null,
    isPicking,
    isManualOpen,
    lastRunHealth,
  });
  const isCollapsed = canCollapse && !isExpanded;

  return (
    <section
      aria-labelledby={headingId}
      className="@container bg-card border-border overflow-hidden rounded-xl border"
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5",
          isCollapsed ? null : "border-border border-b",
        )}
      >
        {/* Eyebrow styling on a real heading: the block needs a title in the
            outline, and <Eyebrow> is a <p> by design. */}
        <h2
          id={headingId}
          className="text-foreground-subtle font-mono text-xs tracking-widest uppercase"
        >
          Nguồn đang đọc
        </h2>

        {/* Collapsed: the two ids and the tab name ARE the summary. There is no
            folder or spreadsheet NAME in `CatalogSource` (the API stores ids,
            urls and `sheetName` only), and inventing one — or fetching it from
            Drive in the browser — is not on the table. */}
        {isCollapsed && configured !== null ? (
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            <span className="font-mono" title={configured.driveFolderId}>
              Drive {shortenId(configured.driveFolderId)}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="font-mono" title={configured.spreadsheetId}>
              Sheet {shortenId(configured.spreadsheetId)}
            </span>
            <span aria-hidden="true"> · </span>
            tab <span className="text-foreground font-medium">{configured.sheetName}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {source.isFetching || connection.isFetching ? (
            <Badge tone="neutral">Đang làm mới…</Badge>
          ) : null}

          {/* One control for the whole card, and it names what it does. In
              read-only support mode it promises READING, because that is all it
              can deliver — the editors behind it are gated off (M3.3).
              `aria-controls` is dropped while folded: the panel it names is
              unmounted, and pointing at an absent id is worse than pointing at
              nothing. `aria-expanded` is valid on its own. */}
          {canCollapse ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={isExpanded}
              aria-controls={isCollapsed ? undefined : detailsId}
              onClick={() => setIsExpanded((open) => !open)}
            >
              {isExpanded ? "Thu gọn" : gate.isDisabled ? "Xem chi tiết nguồn" : "Đổi nguồn"}
            </Button>
          ) : null}
          {/* Only for the tenants the picker cannot serve, and only once the
              status is known — offering it while the answer is still loading
              would flash a button at everyone. Suppressed while the card can
              collapse: the control above already carries this label, and two
              buttons reading "Đổi nguồn" side by side is a coin toss. The
              manual editor is still one click away as its own disclosure at the
              foot of the opened card. */}
          {!canCollapse && configured !== null && needsManualEntry && !isPicking && !gate.isDisabled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={isManualOpen}
              aria-controls={manualPanelId}
              onClick={() => setIsManualOpen((open) => !open)}
            >
              Đổi nguồn
            </Button>
          ) : null}
        </div>
      </div>

      {/* Unmounted when collapsed, not hidden: the picker and the manual form
          hold draft values and server errors, and a form nobody can see must
          not keep either alive. */}
      {isCollapsed ? null : (
        <div id={detailsId}>
          <GoogleConnectionPanel
            connection={connection}
            disconnect={disconnect}
            outcome={outcome}
            onDismissOutcome={() => setOutcome(null)}
            onPickSource={() => setIsPicking(true)}
            isPicking={isPicking}
          />

          {isPicking ? (
            <div className="border-border space-y-3 border-b p-4">
              <p className="text-muted-foreground max-w-prose text-sm">
                Chọn thư mục ảnh, bảng Google Sheet và tab dữ liệu ngay tại đây. Nguồn chỉ được lưu
                ở bước cuối, sau khi bạn xác nhận.
              </p>
              <GoogleDrivePicker onSaved={finishSourceChange} onCancel={() => setIsPicking(false)} />
            </div>
          ) : (
            <SourceRegion
              isFirstLoad={isFirstLoad}
              showSkeleton={showSkeleton}
              isError={source.isError}
              error={source.error}
              onRetry={() => void source.refetch()}
              configured={configured}
              isConnectionPending={isConnectionFirstLoad}
              canPick={isConnected && !gate.isDisabled}
              onPick={() => setIsPicking(true)}
              readOnlyReason={gate.reason}
            />
          )}

          {/* The manual editor is not offered at all in read-only mode: a form
              whose save can only 403 invites typing that gets thrown away. */}
          {gate.isDisabled ? null : (
            <ManualSourceDisclosure
              panelId={manualPanelId}
              isOpen={isManualOpen}
              onToggle={() => setIsManualOpen((open) => !open)}
            >
              <CatalogSourceForm
                current={configured ?? undefined}
                onSaved={finishSourceChange}
                onCancel={() => setIsManualOpen(false)}
              />
            </ManualSourceDisclosure>
          )}
        </div>
      )}

      {/* OUTSIDE the fold, on purpose: a disconnect that failed left the token
          stored, and that fact must not disappear with the panel that started
          it. `canCollapse` also refuses to fold while it is on screen, so this
          renders inside an open card — never orphaned under a summary row.

          …which is why it needs a way OUT (B-4). A mutation keeps its error
          until it is reset or fired again, so without this button one failed
          disconnect pinned the whole card open for the rest of the session,
          long after the operator had read it — and the fold exists precisely so
          settled configuration stops covering the run's numbers. Dismissing is
          local UI state, not a write, so it is not gated in support mode; the
          RETRY is the panel's own "Ngắt kết nối" above, which still asks for
          confirmation and is still gated. */}
      {disconnect.isError ? (
        <div className="border-border border-t p-4">
          <ApiErrorNotice
            error={disconnect.error}
            extraAction={
              <Button type="button" variant="outline" size="sm" onClick={() => disconnect.reset()}>
                Đã đọc, ẩn cảnh báo
              </Button>
            }
          />
        </div>
      ) : null}
    </section>
  );
}

/** Loading / error / empty / data for the stored source, in that order. */
function SourceRegion({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  configured,
  isConnectionPending,
  canPick,
  onPick,
  readOnlyReason = null,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  configured: CatalogSource | null;
  /** The connection status has not answered yet — `canPick` means nothing. */
  isConnectionPending: boolean;
  /** Only a connected tenant can open the in-app picker. */
  canPick: boolean;
  onPick: () => void;
  /** Set while the app is read-only (support mode, M3.3). */
  readOnlyReason?: string | null;
}) {
  if (isFirstLoad) {
    return showSkeleton ? <SourceFactsSkeleton /> : null;
  }

  if (isError) {
    return (
      <div className="border-border border-b p-4">
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </div>
    );
  }

  // Empty: nothing configured yet. The way forward depends on whether the
  // tenant can use the picker at all — offering a dead button would be a lie.
  if (configured === null) {
    // …and while the status is still loading there IS no answer, so nothing is
    // said. Rendering the "chưa kết nối" wording first and swapping it a moment
    // later reads as the screen changing its mind.
    if (isConnectionPending) {
      return showSkeleton ? <SourceEmptySkeleton /> : null;
    }

    return (
      <div className="border-border space-y-3 border-b p-4">
        <p className="text-muted-foreground max-w-prose text-sm">
          Chưa cấu hình nguồn Drive/Sheet cho đơn vị này, nên chưa chạy đồng bộ được.
          {readOnlyReason
            ? ""
            : canPick
              ? " Chọn thư mục ảnh và bảng sản phẩm ngay trong app."
              : " Kết nối Google ở trên, hoặc nhập link/ID thủ công ở phần dưới."}
        </p>
        {/* In read-only mode the "làm gì tiếp theo" belongs to whoever owns the
            company, not to the person reading over their shoulder. */}
        <ReadOnlyNotice reason={readOnlyReason} className="max-w-prose" />
        {canPick ? (
          <Button type="button" onClick={onPick}>
            Chọn thư mục và bảng
          </Button>
        ) : null}
      </div>
    );
  }

  return <SourceFacts source={configured} />;
}

function SourceFacts({ source }: { source: CatalogSource }) {
  return (
    <>
      <dl className="grid grid-cols-1 @lg:grid-cols-2">
        <SourceColumn
          label="Thư mục Drive"
          id={source.driveFolderId}
          href={source.driveFolderUrl}
          linkLabel="Mở thư mục"
          className="border-border border-b @lg:border-r @lg:border-b-0"
        />
        <SourceColumn
          label="Bảng Sheet"
          id={source.spreadsheetId}
          href={source.spreadsheetUrl}
          linkLabel="Mở bảng"
          extra={
            <>
              tab <span className="text-foreground font-medium">{source.sheetName}</span>
            </>
          }
        />
      </dl>

      <p className="text-muted-foreground border-border border-t border-b px-4 py-2 text-xs">
        Hệ thống chỉ đọc đúng hai nguồn trên. Đổi nguồn xong phải chạy đồng bộ lại — lần đồng bộ kế
        tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới.
      </p>
    </>
  );
}

function SourceColumn({
  label,
  id,
  href,
  linkLabel,
  extra,
  className,
}: {
  label: string;
  id: string;
  href: string;
  linkLabel: string;
  extra?: React.ReactNode;
  className?: string;
}) {
  return (
    // One <div> per dt/dd pair — the only wrapper a <dl> may contain.
    <div className={cn("space-y-1 px-4 py-3", className)}>
      <dt className="text-muted-foreground text-xs">
        {label}
        {extra ? <> · {extra}</> : null}
      </dt>
      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* `title` keeps the full id reachable without pasting 44 chars. */}
        <span className="text-muted-foreground font-mono text-xs break-all" title={id}>
          {shortenId(id)}
        </span>
        <a
          href={href}
          target="_blank"
          // noopener: an external tab must not get a handle on this one.
          rel="noopener noreferrer"
          className="text-primary text-sm whitespace-nowrap underline underline-offset-4"
        >
          {linkLabel}
          <span className="sr-only"> (mở tab mới)</span> <span aria-hidden="true">↗</span>
        </a>
      </dd>
    </div>
  );
}

/**
 * The manual escape hatch, demoted to a disclosure. Controlled rather than a
 * native <details> because the card opens it by itself when it is the only way
 * forward — and `aria-expanded` + `aria-controls` give a screen reader the same
 * information the chevron gives everyone else.
 */
function ManualSourceDisclosure({
  panelId,
  isOpen,
  onToggle,
  children,
}: {
  /** Owned by the card: the header's "Đổi nguồn" points at this same panel. */
  panelId: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-visible:ring-ring/50 hover:bg-muted/50 flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-3"
        >
          <span>Hoặc nhập link/ID thủ công</span>
          <span aria-hidden="true" className="text-muted-foreground text-xs">
            {isOpen ? "▲" : "▼"}
          </span>
        </button>
      </h3>

      {/* Unmounted when closed on purpose: a hidden form keeps draft values and
          server errors alive where nobody can see them. */}
      {isOpen ? (
        <div id={panelId} className="space-y-3 px-4 pb-4">
          <p className="text-muted-foreground max-w-prose text-sm">
            Dùng khi đơn vị đọc Drive bằng Service Account, hoặc khi bạn đã có sẵn link/ID. Không
            cần kết nối Google cho cách này.
          </p>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Placeholder for the empty state while the connection status decides WHICH
 * empty state it is. Same two lines + button height as the real block, so the
 * answer lands without pushing the card around.
 */
function SourceEmptySkeleton() {
  return (
    <div
      aria-hidden="true"
      className="border-border space-y-3 border-b p-4 motion-safe:animate-pulse"
    >
      <div className="space-y-2">
        <div className="bg-muted h-4 w-full max-w-prose rounded" />
        <div className="bg-muted h-4 w-2/3 max-w-prose rounded" />
      </div>
      <div className="bg-muted h-9 w-44 rounded-lg" />
    </div>
  );
}

/**
 * Same shape as the real facts block so nothing jumps (CLS = 0) — which means
 * the SAME breakpoint system too: a viewport breakpoint here would flip to two
 * columns at a width where the real card is still one, and the jump would be
 * back.
 */
function SourceFactsSkeleton() {
  return (
    <div aria-hidden="true" className="border-border border-b motion-safe:animate-pulse">
      <div className="grid grid-cols-1 @lg:grid-cols-2">
        {[0, 1].map((cell) => (
          <div key={cell} className="space-y-2 px-4 py-3">
            <div className="bg-muted h-3 w-28 rounded" />
            <div className="bg-muted h-4 w-44 rounded" />
          </div>
        ))}
      </div>
      <div className="border-border border-t px-4 py-2">
        <div className="bg-muted h-3 w-full rounded" />
      </div>
    </div>
  );
}
