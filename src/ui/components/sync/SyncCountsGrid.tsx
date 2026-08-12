import { cn } from "@/shared/utils";
import { SYNC_COUNT_GROUPS, type SyncRunCounts } from "@/ui/schemas/sync.schema";

/**
 * The numbers of one sync run, grouped the way an operator reads them.
 * Presentational: it receives counts and renders them, nothing else.
 *
 * A `warn` item is only tinted when it is non-zero — "0 file bị loại" is good
 * news and must not look like a problem.
 */
export function SyncCountsGrid({ counts }: { counts: SyncRunCounts }) {
  return (
    <div className="space-y-5">
      {SYNC_COUNT_GROUPS.map((group) => (
        <section key={group.title} aria-labelledby={`counts-${slug(group.title)}`}>
          <h3
            id={`counts-${slug(group.title)}`}
            className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
          >
            {group.title}
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {group.items.map((item) => {
              const value = counts[item.key];
              const isNumber = typeof value === "number";
              const highlight = item.tone === "warn" && isNumber && value > 0;

              return (
                <div
                  key={item.key}
                  className={cn(
                    "bg-card rounded-lg border p-3",
                    highlight && "border-warning/40 bg-warning/5",
                  )}
                >
                  <dt className="text-muted-foreground text-xs">{item.label}</dt>
                  <dd
                    className={cn(
                      "mt-1 text-xl font-semibold tabular-nums",
                      highlight && "text-warning-foreground",
                    )}
                  >
                    {isNumber ? value.toLocaleString("vi-VN") : "—"}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Stable id fragment for the `aria-labelledby` link between h3 and dl. */
function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
}
