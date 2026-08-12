/**
 * Skeleton with the SAME eight columns and row height as `JobLogTable`
 * (web-data-table rule 1: a mismatched skeleton is a layout shift).
 */
export function JobLogSkeleton() {
  return (
    <div aria-hidden="true" className="motion-safe:animate-pulse overflow-hidden rounded-xl border">
      <div className="bg-muted/50 h-9" />
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex h-16 items-center gap-3 border-t px-3">
          <div className="bg-muted h-4 w-[12%] rounded" />
          <div className="bg-muted h-4 w-[11%] rounded" />
          <div className="bg-muted h-4 w-[8%] rounded" />
          <div className="bg-muted h-4 w-[13%] rounded" />
          <div className="bg-muted h-5 w-[10%] rounded-full" />
          <div className="bg-muted h-4 w-[5%] rounded" />
          <div className="bg-muted h-4 flex-1 rounded" />
          <div className="bg-muted h-7 w-20 rounded-lg" />
        </div>
      ))}
    </div>
  );
}
