/**
 * Loading placeholder for TenantHealthCard. Heights mirror the real card so the
 * layout does not shift when data arrives (web-feedback-states rule 1: CLS = 0).
 * `aria-hidden` because a screen reader has nothing to gain from grey boxes —
 * the live region next to it announces "đang kiểm tra".
 */
export function TenantHealthSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="bg-card space-y-4 rounded-xl border p-5 motion-safe:animate-pulse"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="bg-muted h-5 w-40 rounded" />
        <div className="bg-muted h-6 w-24 rounded-full" />
      </div>
      <div className="space-y-2">
        <div className="bg-muted h-4 w-72 max-w-full rounded" />
        <div className="bg-muted h-4 w-52 max-w-full rounded" />
        <div className="bg-muted h-4 w-60 max-w-full rounded" />
      </div>
    </div>
  );
}
