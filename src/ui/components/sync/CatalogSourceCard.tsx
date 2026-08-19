"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { CatalogSourceForm } from "@/ui/components/sync/CatalogSourceForm";
import { GoogleConnectionPanel } from "@/ui/components/sync/GoogleConnectionPanel";
import { GoogleDrivePicker } from "@/ui/components/sync/GoogleDrivePicker";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useCatalogSource } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useGoogleConnection } from "@/ui/hooks/useGoogleDrive";
import { shortenId, type CatalogSource } from "@/ui/schemas/catalog.schema";
import {
  parseGoogleConnectOutcome,
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
 */
export function CatalogSourceCard({
  tenantId,
  onSourceChanged,
}: {
  tenantId: string | null;
  /** Lets the screen point at "Chạy đồng bộ" right after a source change. */
  onSourceChanged?: () => void;
}) {
  const baseId = useId();
  const headingId = `${baseId}-source`;
  // Lifted out of the disclosure: the "Đổi nguồn" button in the header points
  // at the SAME panel, so both controls need the id.
  const manualPanelId = `${baseId}-manual`;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const source = useCatalogSource(tenantId);
  const connection = useGoogleConnection(tenantId);

  const [isPicking, setIsPicking] = useState(false);
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [hasAutoOpenedManual, setHasAutoOpenedManual] = useState(false);

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
    if (parsed) setOutcome(parsed);
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

  // --- Idle: no tenant picked yet ------------------------------------------
  if (tenantId === null) return null;

  function finishSourceChange() {
    setIsPicking(false);
    setIsManualOpen(false);
    onSourceChanged?.();
  }

  return (
    <section
      aria-labelledby={headingId}
      className="@container bg-card border-border overflow-hidden rounded-xl border"
    >
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        {/* Eyebrow styling on a real heading: the block needs a title in the
            outline, and <Eyebrow> is a <p> by design. */}
        <h2
          id={headingId}
          className="text-foreground-subtle font-mono text-xs tracking-widest uppercase"
        >
          Nguồn đang đọc
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {source.isFetching || connection.isFetching ? (
            <Badge tone="neutral">Đang làm mới…</Badge>
          ) : null}
          {/* Only for the tenants the picker cannot serve, and only once the
              status is known — offering it while the answer is still loading
              would flash a button at everyone. */}
          {configured !== null && needsManualEntry && !isPicking ? (
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

      <GoogleConnectionPanel
        tenantId={tenantId}
        connection={connection}
        outcome={outcome}
        onDismissOutcome={() => setOutcome(null)}
        onPickSource={() => setIsPicking(true)}
        isPicking={isPicking}
      />

      {isPicking ? (
        <div className="border-border space-y-3 border-b p-4">
          <p className="text-muted-foreground max-w-prose text-sm">
            Chọn thư mục ảnh, bảng Google Sheet và tab dữ liệu ngay tại đây. Nguồn chỉ được lưu ở
            bước cuối, sau khi bạn xác nhận.
          </p>
          <GoogleDrivePicker
            tenantId={tenantId}
            onSaved={finishSourceChange}
            onCancel={() => setIsPicking(false)}
          />
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
          canPick={isConnected}
          onPick={() => setIsPicking(true)}
        />
      )}

      <ManualSourceDisclosure
        panelId={manualPanelId}
        isOpen={isManualOpen}
        onToggle={() => setIsManualOpen((open) => !open)}
      >
        <CatalogSourceForm
          tenantId={tenantId}
          current={configured ?? undefined}
          onSaved={finishSourceChange}
          onCancel={() => setIsManualOpen(false)}
        />
      </ManualSourceDisclosure>
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
          {canPick
            ? " Chọn thư mục ảnh và bảng sản phẩm ngay trong app."
            : " Kết nối Google ở trên, hoặc nhập link/ID thủ công ở phần dưới."}
        </p>
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
