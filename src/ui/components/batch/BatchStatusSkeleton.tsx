/**
 * Skeleton shaped like the real batch screen: same card, same six totals, same
 * four table columns and row height — a skeleton of the wrong shape is just a
 * layout shift with extra steps (web-feedback-states / web-data-table rule 1).
 */
export function BatchStatusSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="bg-card space-y-4 rounded-xl border p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="bg-muted h-5 w-32 rounded" />
          <div className="bg-muted h-5 w-24 rounded-full" />
        </div>
        <div className="bg-muted h-4 w-full max-w-md rounded" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((cell) => (
            <div key={cell} className="bg-muted/40 space-y-2 rounded-lg border p-3">
              <div className="bg-muted h-3 w-16 rounded" />
              <div className="bg-muted h-6 w-10 rounded" />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="bg-muted h-5 w-48 rounded" />
        <div className="overflow-hidden rounded-xl border">
          <div className="bg-muted/50 h-9" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-14 items-center gap-3 border-t px-3">
              <div className="bg-muted h-4 w-1/5 rounded" />
              <div className="bg-muted h-4 w-1/6 rounded" />
              <div className="bg-muted h-4 w-10 rounded" />
              <div className="bg-muted h-4 flex-1 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
