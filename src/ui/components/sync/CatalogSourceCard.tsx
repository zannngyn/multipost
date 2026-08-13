"use client";

import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { CatalogSourceForm } from "@/ui/components/sync/CatalogSourceForm";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useCatalogSource } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { shortenId, type CatalogSource } from "@/ui/schemas/catalog.schema";

/**
 * "Nguồn dữ liệu" — WHICH Drive folder and WHICH Sheet tab this tenant reads.
 *
 * It exists because the commonest support question about a sync is not "did it
 * run" but "did it read the right folder": before this card the operator had no
 * way to answer it from the screen. The ids come from `tenant_integration`, are
 * shown shortened (30 chars of noise help nobody) and each one links out to the
 * real thing so the answer takes one click.
 *
 * Four states: loading (skeleton) / data / empty (chưa cấu hình) / error.
 */
export function CatalogSourceCard({
  tenantId,
  onSourceChanged,
}: {
  tenantId: string | null;
  /** Lets the screen point at "Chạy đồng bộ" right after a source change. */
  onSourceChanged?: () => void;
}) {
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

  return (
    <section aria-labelledby="source-heading" className="bg-card space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="source-heading" className="text-base font-semibold">
          Nguồn dữ liệu
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {source.isFetching ? <Badge tone="neutral">Đang làm mới…</Badge> : null}
          {configured && !isEditing ? (
            <Button type="button" variant="outline" onClick={() => setIsEditing(true)}>
              Đổi nguồn
            </Button>
          ) : null}
        </div>
      </div>

      {/* Not configured -> the form IS the empty state: an operator who has
          nothing yet needs the way to fix it, not a description of the gap. */}
      {configured === null ? (
        <>
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
        </>
      ) : isEditing ? (
        <CatalogSourceForm
          tenantId={tenantId}
          current={configured}
          onSaved={() => {
            setIsEditing(false);
            onSourceChanged?.();
          }}
          onCancel={() => setIsEditing(false)}
        />
      ) : (
        <SourceFacts source={configured} />
      )}
    </section>
  );
}

function SourceFacts({ source }: { source: CatalogSource }) {
  return (
    <>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <SourceRow
          label="Thư mục ảnh (Google Drive)"
          id={source.driveFolderId}
          href={source.driveFolderUrl}
          linkLabel="Mở thư mục Drive"
        />
        <SourceRow
          label="Bảng sản phẩm (Google Sheet)"
          id={source.spreadsheetId}
          href={source.spreadsheetUrl}
          linkLabel="Mở bảng Sheet"
          extra={
            <>
              Tab đang đọc: <span className="text-foreground font-medium">{source.sheetName}</span>
            </>
          }
        />
      </dl>

      <p className="text-muted-foreground text-xs">
        Hệ thống chỉ đọc đúng hai nguồn trên. Đổi nguồn xong phải chạy đồng bộ lại — lần đồng bộ kế
        tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới.
      </p>
    </>
  );
}

function SourceRow({
  label,
  id,
  href,
  linkLabel,
  extra,
}: {
  label: string;
  id: string;
  href: string;
  linkLabel: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="space-y-1">
        {/* `title` keeps the full id reachable without pasting 44 chars on screen. */}
        <p className="font-mono text-xs break-all" title={id}>
          {shortenId(id)}
        </p>
        {extra ? <p className="text-xs">{extra}</p> : null}
        <a
          href={href}
          target="_blank"
          // noopener: an external tab must not get a handle on this one.
          rel="noopener noreferrer"
          className="text-primary inline-flex items-center gap-1 text-sm underline underline-offset-4"
        >
          {linkLabel}
          <span className="sr-only"> (mở tab mới)</span>
          <span aria-hidden="true">↗</span>
        </a>
      </dd>
    </div>
  );
}

/** Same block height as the real card so nothing jumps (CLS = 0). */
function CatalogSourceSkeleton() {
  return (
    <div aria-hidden="true" className="bg-card space-y-3 rounded-xl border p-5 motion-safe:animate-pulse">
      <div className="bg-muted h-5 w-40 rounded" />
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((cell) => (
          <div key={cell} className="space-y-2">
            <div className="bg-muted h-3 w-44 rounded" />
            <div className="bg-muted h-4 w-32 rounded" />
            <div className="bg-muted h-4 w-28 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
