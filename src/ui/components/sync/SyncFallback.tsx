import { SyncRailSkeleton, SyncStatusSkeleton } from "@/ui/components/sync/SyncStatusSkeleton";

/**
 * Suspense fallback for "Đồng bộ dữ liệu". The screen reads the Google OAuth
 * callback from the query string, so it suspends until the request's search
 * params are known; this mirrors the real frame — sticky header, main column,
 * right rail — so the layout does not jump when they resolve (CLS = 0).
 */
export function SyncFallback() {
  return (
    <div aria-hidden="true" className="@container bg-background h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col overflow-y-auto @5xl:flex-row @5xl:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-border flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b px-6 py-4 motion-safe:animate-pulse">
            <div className="min-w-0 space-y-2">
              <div className="bg-muted h-7 w-56 rounded" />
              <div className="bg-muted h-4 w-96 max-w-full rounded" />
            </div>
            <div className="bg-muted h-9 w-36 rounded-lg" />
          </div>

          <div className="flex min-w-0 flex-col gap-5 px-6 py-5">
            <div className="bg-muted h-9 w-72 max-w-full rounded-lg motion-safe:animate-pulse" />
            <div className="border-border h-40 rounded-xl border motion-safe:animate-pulse" />
            <SyncStatusSkeleton />
          </div>
        </div>

        <div className="border-border bg-card shrink-0 border-t px-5 py-5 @5xl:w-90 @5xl:border-t-0 @5xl:border-l">
          <SyncRailSkeleton />
        </div>
      </div>
    </div>
  );
}
