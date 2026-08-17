"use client";

import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { CatalogSourceForm } from "@/ui/components/sync/CatalogSourceForm";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useCatalogSource } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { shortenId, type CatalogSource } from "@/ui/schemas/catalog.schema";

/**
 * "Nguồn đang đọc" — WHICH Drive folder and WHICH Sheet tab this tenant reads.
 *
 * It exists because the commonest support question about a sync is not "did it
 * run" but "did it read the right folder": before this card the operator had no
 * way to answer it from the screen. The ids come from `tenant_integration`, are
 * shown shortened (30 chars of noise help nobody) and each one links out to the
 * real thing so the answer takes one click.
 *
 * Four states: loading (skeleton) / data / empty (chưa cấu hình -> the form) /
 * error.
 */
export function CatalogSourceCard({
  tenantId,
  onSourceChanged,
}: {
  tenantId: string | null;
  /** Lets the screen point at "Chạy đồng bộ" right after a source change. */
  onSourceChanged?: () => void;
}) {
  const headingId = `${useId()}-source`;
  const source = useCatalogSource(tenantId);
  const isFirstLoad = source.isPending && source.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const [isEditing, setIsEditing] = useState(false);

  // --- Idle: no tenant picked yet ------------------------------------------
  if (tenantId === null) return null;

  if (isFirstLoad) return showSkeleton ? <CatalogSourceSkeleton /> : null;

  if (source.isError) {
    return <ApiErrorNotice error={source.error} onRetry={() => void source.refetch()} />;
  }

  if (!source.data) return null;

  const configured = source.data.state === "configured" ? source.data.source : null;
  const isCompact = configured !== null && !isEditing;

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
          {source.isFetching ? <Badge tone="neutral">Đang làm mới…</Badge> : null}
          {configured && !isEditing ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              Đổi nguồn
            </Button>
          ) : null}
        </div>
      </div>

      {/* Not configured -> the form IS the empty state: an operator who has
          nothing yet needs the way to fix it, not a description of the gap. */}
      {configured === null ? (
        <div className="space-y-3 p-4">
          <p className="text-muted-foreground max-w-prose text-sm">
            Chưa cấu hình nguồn Drive/Sheet cho đơn vị này. Khai báo thư mục ảnh và bảng sản phẩm
            bên dưới (lưu vào cấu hình đơn vị — tenant_integration, provider “google”), rồi chạy
            đồng bộ lần đầu.
          </p>
          <CatalogSourceForm
            tenantId={tenantId}
            onSaved={() => {
              setIsEditing(false);
              onSourceChanged?.();
            }}
          />
        </div>
      ) : isCompact ? (
        <SourceFacts source={configured} />
      ) : (
        <div className="p-4">
          <CatalogSourceForm
            tenantId={tenantId}
            current={configured}
            onSaved={() => {
              setIsEditing(false);
              onSourceChanged?.();
            }}
            onCancel={() => setIsEditing(false)}
          />
        </div>
      )}
    </section>
  );
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

      <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">
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
 * Same shape as the real card so nothing jumps (CLS = 0) — which means the
 * SAME breakpoint system too: a viewport breakpoint here would flip to two
 * columns at a width where the real card is still one, and the jump would be
 * back.
 */
function CatalogSourceSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="@container bg-card border-border overflow-hidden rounded-xl border motion-safe:animate-pulse"
    >
      <div className="border-border border-b px-4 py-2.5">
        <div className="bg-muted h-4 w-32 rounded" />
      </div>
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
