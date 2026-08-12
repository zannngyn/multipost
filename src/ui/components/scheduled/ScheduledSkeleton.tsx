/**
 * Skeleton with the SAME day heading + five columns and row height as the real
 * list (web-data-table rule 1: a mismatched skeleton is a layout shift).
 */
export function ScheduledSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      {[0, 1].map((group) => (
        <div key={group} className="space-y-2">
          <div className="bg-muted h-5 w-56 rounded" />
          <div className="overflow-hidden rounded-xl border">
            <div className="bg-muted/50 h-9" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-20 items-center gap-3 border-t px-3">
                <div className="bg-muted h-4 w-[14%] rounded" />
                <div className="bg-muted h-4 w-[15%] rounded" />
                <div className="bg-muted h-4 w-[13%] rounded" />
                <div className="bg-muted h-4 flex-1 rounded" />
                <div className="bg-muted h-7 w-20 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
