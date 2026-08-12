import { cn } from "@/shared/utils";

/**
 * Empty state. `kind` exists to stop the classic mistake of showing the same
 * "Chưa có dữ liệu" for four different situations (core-feedback-states §Empty):
 * an operator who filtered nothing out must not think the data was lost.
 *
 * Presentational: the caller supplies the copy and the call to action.
 */
export type EmptyKind = "first-run" | "no-result" | "done" | "idle";

export function EmptyState({
  kind,
  title,
  description,
  action,
  className,
}: {
  kind: EmptyKind;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-empty-kind={kind}
      className={cn(
        "text-muted-foreground bg-muted/30 rounded-xl border border-dashed p-6 text-sm",
        className,
      )}
    >
      <p className="text-foreground font-medium">{title}</p>
      <div className="mt-1 max-w-prose">{description}</div>
      {action ? <div className="mt-4 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
