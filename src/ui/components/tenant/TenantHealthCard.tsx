import { cn } from "@/shared/utils";
import type { TenantHealth } from "@/ui/schemas/tenant-health.schema";

/**
 * Data state of the tenant health screen. Dumb by design: it receives an
 * already-validated object and renders it — no fetching, no branching on
 * business rules (docs/07 §4.1).
 */

const STATUS_LABELS: Record<TenantHealth["status"], string> = {
  active: "Đang hoạt động",
  suspended: "Tạm ngưng",
};

const STATUS_STYLES: Record<TenantHealth["status"], string> = {
  active: "bg-primary/10 text-foreground border-primary/20",
  suspended: "bg-destructive/10 text-destructive border-destructive/30",
};

/**
 * Fixed locale + time zone: the operators are in Vietnam, and reading the
 * browser locale during render would make server and client output differ.
 */
const TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Ho_Chi_Minh",
});

function formatCheckedAt(isoString: string): string {
  const parsed = new Date(isoString);
  // Guard: schema-valid ISO can still be an impossible date (e.g. 2026-02-31).
  if (Number.isNaN(parsed.getTime())) return isoString;
  return TIME_FORMATTER.format(parsed);
}

export interface TenantHealthCardProps {
  data: TenantHealth;
  /** True while a background refresh runs — content stays, nothing is covered. */
  isRefreshing?: boolean;
}

export function TenantHealthCard({ data, isRefreshing = false }: TenantHealthCardProps) {
  return (
    <div className="bg-card space-y-4 rounded-xl border p-5" aria-busy={isRefreshing}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{data.name}</h3>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            STATUS_STYLES[data.status],
          )}
        >
          {STATUS_LABELS[data.status]}
        </span>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Mã đơn vị</dt>
        <dd className="font-mono text-xs break-all sm:text-sm">{data.tenantId}</dd>

        <dt className="text-muted-foreground">Kiểm tra lúc</dt>
        <dd>
          <time dateTime={data.checkedAt}>{formatCheckedAt(data.checkedAt)}</time>
        </dd>

        <dt className="text-muted-foreground">Chuỗi kiểm tra</dt>
        <dd className="text-muted-foreground">
          Giao diện → API nội bộ → usecase → cơ sở dữ liệu: thông suốt.
        </dd>
      </dl>

      {isRefreshing ? (
        <p className="text-muted-foreground text-xs" aria-live="polite">
          Đang làm mới…
        </p>
      ) : null}
    </div>
  );
}
