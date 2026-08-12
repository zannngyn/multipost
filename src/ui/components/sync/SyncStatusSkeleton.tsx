/**
 * Loading placeholder for the sync panel. Sizes mirror the real blocks (status
 * header, three count groups, table head) so nothing jumps when data lands
 * (web-feedback-states rule 1: CLS = 0).
 *
 * `aria-hidden`: a screen reader gains nothing from grey boxes — the live
 * region next to it announces "đang tải".
 */
export function SyncStatusSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="bg-card space-y-3 rounded-xl border p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="bg-muted h-5 w-52 rounded" />
          <div className="bg-muted h-6 w-28 rounded-full" />
        </div>
        <div className="bg-muted h-4 w-72 max-w-full rounded" />
      </div>

      {[0, 1].map((group) => (
        <div key={group} className="space-y-2">
          <div className="bg-muted h-3 w-40 rounded" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[0, 1, 2, 3, 4, 5].map((cell) => (
              <div key={cell} className="bg-card h-[74px] rounded-lg border p-3">
                <div className="bg-muted h-3 w-16 rounded" />
                <div className="bg-muted mt-2 h-6 w-12 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="h-40 rounded-xl border">
        <div className="bg-muted/50 h-9 rounded-t-xl" />
      </div>
    </div>
  );
}
