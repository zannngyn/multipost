"use client";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  HStack,
  Link,
  RadioList,
  RadioListItem,
  Skeleton,
  VisuallyHidden,
} from "@astryxdesign/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { CatalogFileCard } from "@/ui/components/onboarding/CatalogFileCard";
import {
  CATALOG_SOURCE_CHOICES,
  activeSourceChoice,
  isSourceReady,
  missingSourceReason,
} from "@/ui/components/onboarding/catalog-source-choice";
import { CompatibilityReport } from "@/ui/components/onboarding/CompatibilityReport";
import { FieldMapForm } from "@/ui/components/onboarding/FieldMapForm";
import {
  DATA_MAPPING_STEPS,
  DATA_MAPPING_STEP_PARAM,
  canVisitStep,
  resolveStep,
  stepHref,
  stepIndex,
  stepLabel,
  stepStatuses,
  type DataMappingStep,
} from "@/ui/components/onboarding/data-mapping-steps";
import { CatalogSourceCard } from "@/ui/components/sync/CatalogSourceCard";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useCatalogProfile, useInvalidateMapping } from "@/ui/hooks/useCatalogMapping";
import {
  useCatalogSource,
  useUpdateCatalogSource,
  useUploadCatalogFile,
} from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import type {
  CatalogFieldMap,
  CatalogTextSourceKind,
  MediaProfileConfig,
  StockPolicy,
} from "@/ui/schemas/catalog-mapping.schema";
import type { CatalogSource } from "@/ui/schemas/catalog.schema";

/**
 * "Kết nối dữ liệu" (E10) — the onboarding flow that teaches MYSP the shape of
 * a customer's own spreadsheet, once, instead of asking the customer to rename
 * their columns.
 *
 * Three steps, and the step lives in the URL (`?buoc=`), so Back walks the flow
 * instead of leaving it and F5 lands where the operator was (core-wizard).
 * Nothing typed goes into the URL: the source is saved by step 1, and the map by
 * step 3, both to the server — which is also why there is no draft store. The
 * tenant's stored configuration IS the progress.
 *
 * The states this screen must tell apart (core-feedback-states):
 *   idle     — no company chosen yet (`/api/me` still deciding)
 *   loading  — skeletons shaped like the real blocks, delayed 300ms
 *   data     — the step's own body
 *   empty    — step 1 not finished (`not_configured`): steps 2–3 refuse to
 *              render numbers about a spreadsheet nobody named
 *   error    — 4xx (sửa cấu hình, không thử lại được) vs 5xx (thử lại), told
 *              apart by `presentApiError` inside ApiErrorNotice
 */
export function DataMappingScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isResolved } = useActiveTenant();

  const source = useCatalogSource();
  const gate = writeGate(useReadOnlyReason());

  const configuredSource = source.data?.state === "configured" ? source.data.source : null;
  const hasSource = source.data === undefined ? null : isSourceReady(configuredSource);
  const { step, refusedStep } = resolveStep(
    searchParams.get(DATA_MAPPING_STEP_PARAM),
    { hasSource },
  );

  const [isMapDirty, setIsMapDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<DataMappingStep | null>(null);

  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    stepHeadingRef.current?.focus();
  }, [step]);

  function goToStep(next: DataMappingStep) {
    setPendingLeave(null);
    router.push(stepHref(next));
  }

  function requestStep(next: DataMappingStep) {
    if (step === "anh-xa" && isMapDirty && pendingLeave !== next) {
      setPendingLeave(next);
      return;
    }
    goToStep(next);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col gap-1.5 border-b border-border/60 pb-5">
        <p className="font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
          CẤU HÌNH HỆ THỐNG · ONBOARDING
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Kết nối & Ánh xạ dữ liệu
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground max-w-3xl">
          MYSP học cấu trúc bảng sản phẩm của bạn một lần duy nhất. Bạn hoàn toàn không cần phải đổi tên cột hay sắp xếp lại bảng tính đang dùng — hỗ trợ cả Google Sheet và file CSV xuất từ Excel.
        </p>
      </div>

      {/* Step Rail */}
      <StepRail current={step} hasSource={hasSource} onNavigate={requestStep} />

      <VisuallyHidden as="div" role="status" aria-live="polite">
        {`Bước ${String(stepIndex(step) + 1)} trên ${String(DATA_MAPPING_STEPS.length)}: ${stepLabel(step)}`}
      </VisuallyHidden>

      {/* Refused Step Alert */}
      {refusedStep ? (
        <Banner
          status="info"
          title={`Chưa mở được bước “${stepLabel(refusedStep)}”`}
          description="Bước này cần đọc bảng sản phẩm thật của đơn vị, nên bạn cần hoàn thành bước khai nguồn dữ liệu trước."
        />
      ) : null}

      {/* Unsaved Changes Banner */}
      {pendingLeave ? (
        <Banner
          status="warning"
          title="Bạn có thay đổi ánh xạ chưa lưu"
          description="Rời khỏi bước này sẽ mất những lựa chọn vừa sửa. Bạn nên lưu trước hoặc xác nhận rời đi."
          endContent={
            <HStack gap={2} wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label="Rời đi, bỏ thay đổi"
                onClick={() => goToStep(pendingLeave)}
              />
              <Button
                variant="ghost"
                size="sm"
                label="Ở lại chỉnh tiếp"
                onClick={() => setPendingLeave(null)}
              />
            </HStack>
          }
        />
      ) : null}

      {/* Idle / No Company */}
      {!isResolved ? (
        <EmptyState
          isCompact
          headingLevel={2}
          title="Chưa chọn công ty"
          description="Vui lòng chọn công ty ở thanh điều hướng trên cùng để bắt đầu kết nối dữ liệu."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {step === "nguon" ? (
            <SourceStep
              isError={source.isError}
              error={source.error}
              onRetry={() => void source.refetch()}
              source={source.data === undefined ? undefined : configuredSource}
              isReady={hasSource}
              readOnlyReason={gate.reason}
              onContinue={() => requestStep("anh-xa")}
            />
          ) : null}

          {step === "anh-xa" ? (
            <MappingStep
              readOnlyReason={gate.reason}
              onDirtyChange={setIsMapDirty}
              onBack={() => requestStep("nguon")}
              onNext={() => requestStep("bao-cao")}
            />
          ) : null}

          {step === "bao-cao" ? (
            <ReportStep onGoToMapping={() => requestStep("anh-xa")} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The progress indicator, as a semantic ordered list (web-wizard rule 5).
 *
 * A step already reachable is a REAL anchor — focusable, middle-clickable,
 * copyable — and its click is intercepted so an unsaved map is never thrown away
 * silently. The interception has to sit ON the anchor: `Item`'s row-level
 * `onClick` deliberately returns early for clicks landing inside an `<a>`
 * (`handleContainerClick`), so a rail built out of `Item href` would navigate
 * straight past the guard.
 *
 * A step nobody may open yet is plain text, not a disabled link — offering a
 * control that bounces back is the same lie as a dead button.
 */
function StepRail({
  current,
  hasSource,
  onNavigate,
}: {
  current: DataMappingStep;
  hasSource: boolean | null;
  onNavigate: (step: DataMappingStep) => void;
}) {
  const statuses = stepStatuses(current, { hasSource });

  return (
    <nav aria-label="Các bước kết nối dữ liệu" className="w-full">
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {DATA_MAPPING_STEPS.map((entry, index) => {
          const status = statuses[entry.key];
          const isCurrent = status === "current";
          const isDone = status === "done";
          const canVisit = canVisitStep(entry.key, { hasSource }) && !isCurrent;

          const cardContent = (
            <div
              className={`group flex h-full flex-col justify-between rounded-lg border p-3.5 transition-all ${
                isCurrent
                  ? "border-primary bg-accent/40 shadow-xs ring-2 ring-primary/20"
                  : isDone
                    ? "border-border/80 bg-card hover:border-primary/40 hover:bg-accent/20 cursor-pointer"
                    : "border-border/40 bg-card/60 opacity-70"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex size-6 items-center justify-center rounded-full font-mono text-xs font-semibold ${
                      isCurrent
                        ? "bg-primary text-primary-foreground"
                        : isDone
                          ? "bg-leaf/20 text-leaf-deep"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDone ? "✓" : `0${index + 1}`}
                  </span>
                  <span
                    className={`text-sm font-medium ${
                      isCurrent
                        ? "text-primary font-semibold"
                        : isDone
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {entry.label}
                  </span>
                </div>

                <Badge
                  variant={isDone ? "success" : isCurrent ? "info" : "neutral"}
                  label={isDone ? "Đã xong" : isCurrent ? "Đang làm" : "Chưa tới"}
                />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {entry.summary}
              </p>
            </div>
          );

          return (
            <li key={entry.key} aria-current={isCurrent ? "step" : undefined}>
              {canVisit ? (
                <Link
                  href={stepHref(entry.key)}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(entry.key);
                  }}
                  className="block h-full no-underline"
                >
                  {cardContent}
                </Link>
              ) : (
                cardContent
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SourceStep({
  isError,
  error,
  onRetry,
  source,
  isReady,
  readOnlyReason,
  onContinue,
}: {
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  source: CatalogSource | null | undefined;
  isReady: boolean | null;
  readOnlyReason: string | null;
  onContinue: () => void;
}) {
  const upload = useUploadCatalogFile();
  const [choice, setChoice] = useState<CatalogTextSourceKind>(() => activeSourceChoice(source));

  return (
    <div className="flex flex-col gap-6">
      {isError ? <ApiErrorNotice error={error} onRetry={onRetry} source="Nguồn dữ liệu" /> : null}

      <div className="rounded-lg border border-border/80 bg-card p-4 md:p-5 shadow-xs">
        <RadioList
          label="Bảng sản phẩm của đơn vị nằm ở đâu"
          value={choice}
          onChange={(next) => setChoice(next as CatalogTextSourceKind)}
          isDisabled={upload.isPending}
        >
          {CATALOG_SOURCE_CHOICES.map((entry) => (
            <RadioListItem
              key={entry.kind}
              value={entry.kind}
              label={entry.label}
              description={`${entry.summary} ${entry.fitFor}`}
            />
          ))}
        </RadioList>
      </div>

      {choice === "google_sheet" ? (
        <CatalogSourceCard lastRunHealth="unknown" />
      ) : (
        <CatalogFileCard
          textSource={source?.textSource}
          preview={upload.data?.preview ?? null}
          isUploading={upload.isPending}
          error={upload.isError ? upload.error : null}
          readOnlyReason={readOnlyReason}
          onUpload={(file) =>
            upload.mutate(
              { file },
              {
                onSuccess: onContinue,
              },
            )
          }
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 p-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">Sẵn sàng sang bước ánh xạ cột?</p>
          <p className="text-xs text-muted-foreground">
            Hệ thống chỉ đọc dòng tiêu đề và mẫu dữ liệu từ bảng của bạn — không sửa, không ghi đè gì lên bảng gốc.
          </p>
        </div>
        <Button
          variant="primary"
          label="Tiếp tục: Ánh xạ cột →"
          isDisabled={isReady !== true || upload.isPending}
          tooltip={
            isReady === null
              ? "Đang đọc cấu hình hiện tại…"
              : (missingSourceReason(source) ?? "Vui lòng chọn nguồn dữ liệu ở trên trước.")
          }
          onClick={onContinue}
        />
      </div>
    </div>
  );
}

function ReportStep({ onGoToMapping }: { onGoToMapping: () => void }) {
  const profile = useCatalogProfile();
  const router = useRouter();
  const isFirstLoad = profile.isPending && profile.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  if (isFirstLoad) {
    return showSkeleton ? <ReportSkeleton /> : null;
  }

  if (profile.isError) {
    return (
      <ApiErrorNotice
        error={profile.error}
        onRetry={() => void profile.refetch()}
        source="Báo cáo tương thích"
      />
    );
  }

  if (profile.data?.state !== "profiled") {
    return (
      <EmptyState
        isCompact
        headingLevel={3}
        title="Chưa có nguồn dữ liệu để đọc"
        description="Vui lòng quay lại bước 1 “Nguồn dữ liệu” để kết nối bảng Google Sheet hoặc tải file CSV lên."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <CompatibilityReport report={profile.data.report} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 pt-4">
        <Button
          variant="secondary"
          label="← Quay lại chỉnh ánh xạ cột"
          onClick={onGoToMapping}
        />

        <HStack gap={2} wrap="wrap">
          <Button
            variant="secondary"
            label={profile.isFetching ? "Đang đọc lại…" : "Chạy lại báo cáo"}
            isLoading={profile.isFetching}
            isDisabled={profile.isFetching}
            onClick={() => void profile.refetch()}
          />
          <Button
            variant="primary"
            label="Đi tới Đồng bộ dữ liệu →"
            onClick={() => router.push("/sync")}
          />
        </HStack>
      </div>
    </div>
  );
}

function MappingStep({
  readOnlyReason,
  onDirtyChange,
  onBack,
  onNext,
}: {
  readOnlyReason: string | null;
  onDirtyChange: (isDirty: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const profile = useCatalogProfile();
  const source = useCatalogSource();
  const save = useUpdateCatalogSource();
  const invalidate = useInvalidateMapping();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedMediaProfile, setSavedMediaProfile] = useState<MediaProfileConfig | null>(null);

  const isFirstLoad = profile.isPending && profile.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const report = profile.data?.state === "profiled" ? profile.data.report : null;
  const configured = source.data?.state === "configured" ? source.data.source : null;

  const handleSave = useCallback(
    (payload: {
      fieldMap: CatalogFieldMap;
      stockPolicy: StockPolicy;
      mediaProfile: MediaProfileConfig;
    }) => {
      if (!configured || !report) return;
      save.mutate(
        {
          fieldMap: payload.fieldMap,
          stockPolicy: payload.stockPolicy,
          mediaProfile: payload.mediaProfile,
          sheetColumns: report.sheet.columns.length > 0 ? report.sheet.columns : undefined,
        },
        {
          onSuccess: () => {
            setSavedAt(Date.now());
            setSavedMediaProfile(payload.mediaProfile);
            invalidate();
          },
        },
      );
    },
    [configured, invalidate, report, save],
  );

  if (isFirstLoad) return showSkeleton ? <ReportSkeleton /> : null;

  if (profile.isError) {
    return (
      <ApiErrorNotice
        error={profile.error}
        onRetry={() => void profile.refetch()}
        source="Danh sách cột"
      />
    );
  }

  if (!report || !configured) {
    return (
      <EmptyState
        isCompact
        headingLevel={3}
        title="Chưa đọc được bảng sản phẩm nên chưa có cột để chọn"
        description="Quay lại bước “Nguồn dữ liệu”: kiểm tra bảng Google Sheet (tên tab, quyền chia sẻ), hoặc tải lại file CSV."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {savedAt !== null && !save.isPending ? (
        <Banner
          status="success"
          title="Đã lưu thành công ánh xạ cột, quy tắc kiểm tồn và nguồn ảnh"
          description="Bạn có thể tiếp tục sang bước 3 để xem báo cáo tương thích, hoặc sang màn “Đồng bộ dữ liệu” để hệ thống cập nhật."
          isDismissable
          onDismiss={() => setSavedAt(null)}
          endContent={
            <Button
              variant="secondary"
              size="sm"
              label="Xem Báo cáo tương thích →"
              onClick={onNext}
            />
          }
        />
      ) : null}

      <FieldMapForm
        key={`${report.spreadsheetId}:${report.sheetName}:${savedAt ?? 0}`}
        report={report}
        storedFieldMap={configured.fieldMap}
        storedStockPolicy={configured.stockPolicy}
        storedMediaProfile={configured.mediaProfile ?? savedMediaProfile}
        isSaving={save.isPending}
        saveError={save.isError ? save.error : null}
        readOnlyReason={readOnlyReason}
        onDirtyChange={onDirtyChange}
        onSave={handleSave}
        onBack={onBack}
        onNext={onNext}
      />
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton height={120} />
      <Skeleton height={200} />
      <Skeleton height={140} />
    </div>
  );
}
