"use client";

import { useId, useRef, useState } from "react";

import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useTenantHealth } from "@/ui/hooks/useTenantHealth";
import { ErrorState } from "@/ui/components/feedback/ErrorState";
import { TenantHealthCard } from "@/ui/components/tenant/TenantHealthCard";
import { TenantHealthSkeleton } from "@/ui/components/tenant/TenantHealthSkeleton";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import {
  DEMO_TENANT_ID,
  TenantHealthFormSchema,
} from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * Walking-skeleton screen: component -> hook -> service -> internal HTTP API
 * (docs/07 §4.1). The only client component on the home page; the page itself
 * stays a Server Component.
 *
 * Covers the four mandatory states (core-feedback-states):
 * loading (skeleton) · data (card) · empty (nothing checked yet) · error
 * (400 / 404 / 503 told apart, with a retry button only where retrying helps).
 */

interface ErrorPresentation {
  title: string;
  description: string;
  /** Retrying a bad request just repeats it — the button must not lie. */
  canRetry: boolean;
  /** Shown when the operator, not the server, has to act. */
  showFixInput: boolean;
  sessionExpired?: boolean;
}

function presentError(error: ApiError): ErrorPresentation {
  switch (error.code) {
    case "INVALID_INPUT":
      return {
        title: "Mã đơn vị không hợp lệ",
        description: `${error.userMessage} Mã đơn vị có dạng UUID, ví dụ: ${DEMO_TENANT_ID}.`,
        canRetry: false,
        showFixInput: true,
      };
    case "TENANT_NOT_FOUND":
      return {
        title: "Không tìm thấy đơn vị",
        description: `${error.userMessage} Kiểm tra lại mã, hoặc hỏi quản trị viên mã đơn vị đúng.`,
        canRetry: false,
        showFixInput: true,
      };
    case "UNAUTHORIZED":
      return {
        title: "Phiên đăng nhập đã kết thúc",
        description: `${error.userMessage} Đăng nhập lại để tiếp tục.`,
        canRetry: false,
        showFixInput: false,
        sessionExpired: true,
      };
    case "DB_ERROR":
      return {
        title: "Không truy cập được cơ sở dữ liệu",
        description: `${error.userMessage} Đây là sự cố phía máy chủ — hãy thử lại sau ít phút, hoặc báo quản trị viên nếu kéo dài.`,
        canRetry: true,
        showFixInput: false,
      };
    default:
      return {
        title: "Không kiểm tra được đơn vị",
        description: error.userMessage,
        canRetry: error.isRetryable,
        showFixInput: false,
      };
  }
}

export function TenantHealthPanel() {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  const [tenantIdInput, setTenantIdInput] = useState(DEMO_TENANT_ID);
  const [formError, setFormError] = useState<string | null>(null);
  /** null = the operator has not asked for anything yet (empty state). */
  const [checkedTenantId, setCheckedTenantId] = useState<string | null>(null);

  const query = useTenantHealth(checkedTenantId);
  const isFirstLoad = query.isPending && query.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  function focusInput() {
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Validate at the boundary, before any request leaves the browser.
    const parsed = TenantHealthFormSchema.safeParse({ tenantId: tenantIdInput });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Mã đơn vị không hợp lệ.");
      focusInput();
      return;
    }

    setFormError(null);
    setCheckedTenantId(parsed.data.tenantId);
  }

  return (
    <section className="space-y-4" aria-labelledby={`${inputId}-heading`}>
      <div className="space-y-1">
        <h2 id={`${inputId}-heading`} className="text-lg font-semibold">
          Sức khoẻ đơn vị (tenant)
        </h2>
        <p className="text-muted-foreground text-sm">
          Kiểm tra toàn tuyến: giao diện → API nội bộ → usecase → cơ sở dữ liệu.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-80 space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Mã đơn vị (tenant)
          </label>
          <Input
            id={inputId}
            ref={inputRef}
            name="tenantId"
            value={tenantIdInput}
            onChange={(event) => setTenantIdInput(event.target.value)}
            aria-invalid={formError !== null}
            aria-describedby={formError ? `${errorId} ${hintId}` : hintId}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p id={hintId} className="text-muted-foreground text-xs">
            Dạng UUID. Đơn vị mẫu đã được điền sẵn.
          </p>
          {formError ? (
            <p id={errorId} role="alert" className="text-destructive text-xs">
              {formError}
            </p>
          ) : null}
        </div>

        <Button type="submit" size="lg" disabled={isFirstLoad}>
          {isFirstLoad ? "Đang kiểm tra…" : "Kiểm tra"}
        </Button>
      </form>

      {/* Announce state changes to screen readers without moving focus. */}
      <p className="sr-only" role="status" aria-live="polite">
        {isFirstLoad ? "Đang kiểm tra đơn vị" : ""}
      </p>

      <TenantHealthResult
        checkedTenantId={checkedTenantId}
        showSkeleton={showSkeleton}
        isFirstLoad={isFirstLoad}
        query={query}
        onFixInput={focusInput}
      />
    </section>
  );
}

function TenantHealthResult({
  checkedTenantId,
  showSkeleton,
  isFirstLoad,
  query,
  onFixInput,
}: {
  checkedTenantId: string | null;
  showSkeleton: boolean;
  isFirstLoad: boolean;
  query: ReturnType<typeof useTenantHealth>;
  onFixInput: () => void;
}) {
  // --- Empty: nothing has been asked for yet -------------------------------
  if (checkedTenantId === null) {
    return (
      <div className="text-muted-foreground bg-muted/30 rounded-xl border border-dashed p-6 text-sm">
        <p className="text-foreground font-medium">Chưa kiểm tra đơn vị nào</p>
        <p className="mt-1">
          Nhập mã đơn vị rồi bấm <span className="font-medium">Kiểm tra</span> để xem tình trạng kết
          nối của hệ thống.
        </p>
      </div>
    );
  }

  // --- Loading: skeleton, delayed so a fast answer does not flash ----------
  if (isFirstLoad) return showSkeleton ? <TenantHealthSkeleton /> : null;

  // --- Error: told apart by code; retry only where retrying can succeed ----
  if (query.isError) {
    const error = ApiError.is(query.error)
      ? query.error
      : new ApiError({
          code: "INTERNAL",
          status: 0,
          userMessage: "Hệ thống gặp sự cố không xác định. Vui lòng thử lại sau ít phút.",
        });
    const view = presentError(error);

    return (
      <ErrorState
        className="mx-0 max-w-none"
        title={view.title}
        description={view.description}
        referenceCode={error.code}
        onRetry={view.canRetry ? () => void query.refetch() : undefined}
        secondaryAction={
          view.showFixInput ? (
            <Button type="button" variant="outline" onClick={onFixInput}>
              Sửa mã đơn vị
            </Button>
          ) : view.sessionExpired ? (
            <Button asChild variant="outline">
              <a href="/signin">Đăng nhập lại</a>
            </Button>
          ) : undefined
        }
      />
    );
  }

  // --- Data (with a non-blocking refresh indicator) ------------------------
  if (query.data) {
    return <TenantHealthCard data={query.data} isRefreshing={query.isFetching} />;
  }

  return null;
}
