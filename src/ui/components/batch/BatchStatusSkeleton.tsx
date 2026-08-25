"use client";

export function BatchStatusSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6 motion-safe:animate-pulse">
      {/* Top Card Skeleton */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card p-5">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-4">
          <div className="flex flex-col gap-2">
            <div className="h-4 w-28 rounded-md bg-muted" />
            <div className="h-4 w-72 rounded-md bg-muted" />
          </div>
          <div className="h-10 w-36 rounded-lg bg-muted/60" />
        </div>

        {/* 6-cell Stat Tape Skeleton */}
        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/80 bg-border/40 gap-px sm:grid-cols-3 lg:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((cell) => (
            <div key={cell} className="flex flex-col justify-between bg-card p-3.5 h-20">
              <div className="h-3 w-16 rounded bg-muted" />
              <div className="h-6 w-10 rounded bg-muted font-mono" />
            </div>
          ))}
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
          <div className="h-4 w-32 rounded bg-muted/60" />
          <div className="h-4 w-32 rounded bg-muted/60" />
          <div className="h-4 w-32 rounded bg-muted/60" />
          <div className="h-4 w-32 rounded bg-muted/60" />
        </div>
      </div>

      {/* Table Skeleton */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="h-5 w-44 rounded bg-muted" />
          <div className="h-8 w-60 rounded-lg bg-muted/60" />
        </div>

        <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
          <div className="h-10 bg-muted/40 border-b border-border/60" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4 border-b border-border/40 p-4 last:border-0">
              <div className="h-4 w-40 rounded bg-muted" />
              <div className="h-6 w-24 rounded-full bg-muted" />
              <div className="h-4 w-12 rounded bg-muted" />
              <div className="h-4 w-64 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
