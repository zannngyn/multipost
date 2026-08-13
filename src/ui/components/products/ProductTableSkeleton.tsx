/**
 * Skeleton with the SAME six columns and row height as `ProductTable`
 * (web-data-table rule 1: a mismatched skeleton is a layout shift).
 */
export function ProductTableSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border motion-safe:animate-pulse">
      <div className="bg-muted/50 h-9" />
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="flex h-16 items-center gap-3 border-t px-3">
          <div className="bg-muted h-4 w-[13%] rounded" />
          <div className="bg-muted h-4 w-[23%] rounded" />
          <div className="bg-muted h-4 w-[11%] rounded" />
          <div className="bg-muted h-5 w-[16%] rounded-full" />
          <div className="bg-muted h-4 w-[13%] rounded" />
          <div className="bg-muted h-7 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}
