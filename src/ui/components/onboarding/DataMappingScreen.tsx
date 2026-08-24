"use client";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  Link,
  RadioList,
  RadioListItem,
  Section,
  Skeleton,
  Stack,
  StackItem,
  Text,
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

  /**
   * Is step 1 FINISHED — `null` while the query is still in flight.
   *
   * Null is not "no source": bouncing an operator back to step 1 because a query
   * is in flight is the bug that third state exists to prevent.
   *
   * It asks `isSourceReady` rather than "does a row exist", and since onboarding
   * phase 3 that distinction has teeth in both directions. A tenant who uploaded
   * a CSV has a row whose Google coordinates are all empty strings — a
   * row-exists check would call them unconfigured and refuse them step 2, which
   * is precisely the customer this phase exists for. A tenant with a half-filled
   * Google row would sail through into a report that cannot read anything.
   */
  const hasSource = source.data === undefined ? null : isSourceReady(configuredSource);
  const { step, refusedStep } = resolveStep(
    searchParams.get(DATA_MAPPING_STEP_PARAM),
    { hasSource },
  );

  const [isMapDirty, setIsMapDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<DataMappingStep | null>(null);

  /**
   * Client-side navigation changes the content without moving focus, so a
   * keyboard or screen-reader user is left on the rail with no idea the body
   * changed (web-accessibility rule 3). The heading of the new step takes focus.
   */
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    stepHeadingRef.current?.focus();
  }, [step]);

  // Plain functions, not `useCallback`: the React Compiler is on for this repo
  // and refuses to compile a component whose manual memoization it cannot
  // preserve (`react-hooks/preserve-manual-memoization`). It memoizes these on
  // its own.
  function goToStep(next: DataMappingStep) {
    setPendingLeave(null);
    // push, not replace: Back must walk one step, not leave the flow.
    router.push(stepHref(next));
  }

  /**
   * A rail entry stays a real link (focusable, middle-clickable, copyable), but
   * an unsaved map is not thrown away on the first click: the press is caught,
   * the screen says what is at stake, and a second press goes through.
   */
  function requestStep(next: DataMappingStep) {
    if (step === "anh-xa" && isMapDirty && pendingLeave !== next) {
      setPendingLeave(next);
      return;
    }
    goToStep(next);
  }

  return (
    <Stack direction="vertical" gap={5} padding={4} maxWidth={960}>
      <Stack direction="vertical" gap={1}>
        <Heading level={1}>Kết nối dữ liệu</Heading>
        <Text type="supporting">
          MYSP học cấu trúc bảng của bạn một lần, ngay tại đây. Bạn không phải đổi tên cột hay sắp
          xếp lại bảng đang dùng — dù đó là Google Sheet hay file CSV xuất ra từ Excel.
        </Text>
      </Stack>

      <StepRail current={step} hasSource={hasSource} onNavigate={requestStep} />

      {/*
        Changing step swaps the body without moving the page, so a screen-reader
        user hears nothing (web-wizard rule 5). The region is rendered OUTSIDE
        every conditional so it exists before the text inside it changes —
        a live region mounted together with its message is not announced.
      */}
      <VisuallyHidden as="div" role="status" aria-live="polite">
        {`Bước ${String(stepIndex(step) + 1)} trên ${String(DATA_MAPPING_STEPS.length)}: ${stepLabel(step)}`}
      </VisuallyHidden>

      {/* A refused jump is SAID, never silent (core-wizard). */}
      {refusedStep ? (
        <Banner
          status="info"
          title={`Chưa mở được bước “${stepLabel(refusedStep)}”`}
          description="Bước này đọc bảng sản phẩm thật của đơn vị, nên phải khai nguồn dữ liệu trước. Làm ở bước bên dưới rồi quay lại."
        />
      ) : null}

      {pendingLeave ? (
        <Banner
          status="warning"
          title="Bạn có thay đổi ánh xạ chưa lưu"
          description="Rời khỏi bước này sẽ mất những lựa chọn vừa sửa. Lưu trước, hoặc xác nhận rời đi."
          endContent={
            <HStack gap={2} wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={`Rời đi, bỏ thay đổi`}
                onClick={() => goToStep(pendingLeave)}
              />
              <Button
                variant="ghost"
                size="sm"
                label="Ở lại"
                onClick={() => setPendingLeave(null)}
              />
            </HStack>
          }
        />
      ) : null}

      {/* Idle: no company, no question to ask yet (M1.4). */}
      {!isResolved ? (
        <EmptyState
          isCompact
          headingLevel={2}
          title="Chưa chọn công ty"
          description="Chọn công ty ở thanh trên cùng để bắt đầu kết nối dữ liệu."
        />
      ) : (
        <Stack direction="vertical" gap={4}>
          <Stack direction="vertical" gap={1}>
            {/* `tabIndex={-1}`: focused programmatically after a step change,
                never a tab stop of its own. */}
            <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
              {stepLabel(step)}
            </Heading>
            <Text type="supporting">
              {DATA_MAPPING_STEPS[stepIndex(step)]?.summary ?? ""}
            </Text>
          </Stack>

          {step === "nguon" ? (
            <SourceStep
              isError={source.isError}
              error={source.error}
              onRetry={() => void source.refetch()}
              source={source.data === undefined ? undefined : configuredSource}
              isReady={hasSource}
              readOnlyReason={gate.reason}
              onContinue={() => requestStep("bao-cao")}
            />
          ) : null}

          {step === "bao-cao" ? (
            <ReportStep onGoToMapping={() => requestStep("anh-xa")} />
          ) : null}

          {step === "anh-xa" ? (
            <MappingStep
              readOnlyReason={gate.reason}
              onDirtyChange={setIsMapDirty}
              onBack={() => requestStep("bao-cao")}
            />
          ) : null}
        </Stack>
      )}
    </Stack>
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
    <Section variant="muted" padding={3}>
      <Stack direction="vertical" gap={2} as="ol" aria-label="Các bước kết nối dữ liệu">
        {DATA_MAPPING_STEPS.map((entry, index) => {
          const status = statuses[entry.key];
          const isCurrent = status === "current";
          const canVisit = canVisitStep(entry.key, { hasSource }) && !isCurrent;

          return (
            <Stack
              key={entry.key}
              as="li"
              direction="horizontal"
              gap={2}
              align="start"
              aria-current={isCurrent ? "step" : undefined}
            >
              {/* Mono numerals (DESIGN.md §The Mono Ledger Rule): the number
                  names the order of an invariant flow, it is not a score. */}
              <Text type="code" hasTabularNumbers>
                {String(index + 1)}
              </Text>

              <StackItem size="fill">
                <Stack direction="vertical" gap={0.5}>
                  {canVisit ? (
                    <Link
                      href={stepHref(entry.key)}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(entry.key);
                      }}
                    >
                      {entry.label}
                    </Link>
                  ) : (
                    <Text weight={isCurrent ? "semibold" : "normal"}>{entry.label}</Text>
                  )}
                  <Text type="supporting">{entry.summary}</Text>
                </Stack>
              </StackItem>

              {/* The word, not only the colour (DESIGN.md §The Named Status Rule). */}
              <Badge
                variant={status === "done" ? "success" : isCurrent ? "info" : "neutral"}
                label={status === "done" ? "Đã xong" : isCurrent ? "Đang làm" : "Chưa tới"}
              />
            </Stack>
          );
        })}
      </Stack>
    </Section>
  );
}

/**
 * Step 1 — WHERE this tenant's product table comes from.
 *
 * TWO OPTIONS, AS PEERS (onboarding phase 3). The Google card is listed first
 * because it also brings the photos, not because the other is a fallback: a
 * customer with no Google Workspace has exactly one way to use this product, and
 * filing it under "nâng cao" would tell them what we think of them. The radio
 * list is the same idiom step 3 already uses for the stock policy, so there is
 * nothing new to learn.
 *
 * The chosen option decides only which CARD is on screen. What the tenant
 * actually READS is whatever is stored on the server (`textSource`), and moving
 * the radio changes nothing until the card below it is used — a radio that
 * silently repointed a live catalog would be data loss one click deep.
 */
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
  /** The stored source; `undefined` while the query is still in flight. */
  source: CatalogSource | null | undefined;
  /** Null = the source query has not answered yet. NOT "no source". */
  isReady: boolean | null;
  readOnlyReason: string | null;
  onContinue: () => void;
}) {
  const upload = useUploadCatalogFile();
  /**
   * Which card is showing. Seeded from what is STORED, so a tenant already on a
   * CSV lands on the CSV card instead of a Google form they do not use.
   *
   * Seeded once, in the `useState` initialiser rather than an effect: re-seeding
   * it when the query settles would yank the card out from under somebody who
   * had already switched.
   */
  const [choice, setChoice] = useState<CatalogTextSourceKind>(() => activeSourceChoice(source));

  return (
    <Stack direction="vertical" gap={4}>
      {isError ? <ApiErrorNotice error={error} onRetry={onRetry} source="Nguồn dữ liệu" /> : null}

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

      {choice === "google_sheet" ? (
        /*
          `lastRunHealth="unknown"` is the literal truth from here: this screen
          does not read sync status, and "unknown" is what keeps the card OPEN —
          which is what a setup step needs. It is not a guess dressed as a fact.
        */
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
                /*
                  Straight on to the compatibility report — the same place the
                  Google branch reaches through the button below. ONE flow and
                  one mapping step, which is the whole point of routing both
                  sources through the same wizard.

                  On success only: a refusal has to stay on the card that can
                  explain it, beside the file that caused it.
                */
                onSuccess: onContinue,
              },
            )
          }
        />
      )}

      <HStack gap={2} wrap="wrap" align="center">
        <Button
          variant="primary"
          label="Đọc thử dữ liệu"
          isDisabled={isReady !== true || upload.isPending}
          // `tooltip`, not a bare disabled button: a control that cannot be
          // pressed must say why (DESIGN.md §Named Status Rule) — and the
          // sentence beside it repeats the reason for anyone not hovering.
          tooltip={
            isReady === null
              ? "Đang đọc cấu hình hiện tại…"
              : (missingSourceReason(source) ?? "Khai nguồn dữ liệu ở trên trước đã.")
          }
          onClick={onContinue}
        />
        <Text type="supporting">
          Bước sau chỉ ĐỌC bảng sản phẩm của bạn để đếm — không sửa, không đăng gì.
        </Text>
      </HStack>
    </Stack>
  );
}

/** Step 2 — the compatibility report, with its own four states. */
function ReportStep({ onGoToMapping }: { onGoToMapping: () => void }) {
  const profile = useCatalogProfile();
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
        description="Quay lại bước “Nguồn dữ liệu” và khai bảng sản phẩm của đơn vị này — bảng Google Sheet, hoặc file CSV tải lên."
      />
    );
  }

  return (
    <Stack direction="vertical" gap={4}>
      <CompatibilityReport report={profile.data.report} />

      <HStack gap={2} wrap="wrap" align="center">
        <Button variant="primary" label="Chỉnh ánh xạ cột" onClick={onGoToMapping} />
        <Button
          variant="secondary"
          label={profile.isFetching ? "Đang đọc lại…" : "Chạy lại báo cáo"}
          isLoading={profile.isFetching}
          isDisabled={profile.isFetching}
          onClick={() => void profile.refetch()}
        />
      </HStack>
    </Stack>
  );
}

/** Step 3 — the mapping form, plus what to do after it saves. */
function MappingStep({
  readOnlyReason,
  onDirtyChange,
  onBack,
}: {
  readOnlyReason: string | null;
  onDirtyChange: (isDirty: boolean) => void;
  onBack: () => void;
}) {
  const profile = useCatalogProfile();
  const source = useCatalogSource();
  const save = useUpdateCatalogSource();
  const invalidate = useInvalidateMapping();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /**
   * The media profile of the last successful save, kept only until the server
   * starts echoing it back.
   *
   * `PUT /api/catalog/source` stores it and answers 200, but the response — like
   * the GET — is a `CatalogSourceView`, which does not carry `mediaProfile`
   * today. Without this, remounting the form right after a save would read
   * "chưa khai" and offer the report's recommendation again, i.e. silently
   * propose to overwrite the answer somebody just gave. This holds what the
   * server acknowledged, nothing more, and it dies with the page (a reload falls
   * back to the recommendation until core puts the key on the view).
   */
  const [savedMediaProfile, setSavedMediaProfile] = useState<MediaProfileConfig | null>(null);

  const isFirstLoad = profile.isPending && profile.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const report = profile.data?.state === "profiled" ? profile.data.report : null;
  /**
   * The tenant's STORED configuration, used for two things only: knowing that
   * step 1 is finished, and seeding the form with the map/policy/layout that are
   * currently saved.
   *
   * It is deliberately NOT the source of coordinates for the save any more — see
   * `handleSave`. This value comes from a GET that ran outside any transaction,
   * so anything read here is a snapshot, safe to DISPLAY and unsafe to write
   * back.
   */
  const configured = source.data?.state === "configured" ? source.data.source : null;

  const handleSave = useCallback(
    (payload: {
      fieldMap: CatalogFieldMap;
      stockPolicy: StockPolicy;
      mediaProfile: MediaProfileConfig;
    }) => {
      // Both guards, not one: the stored source and the header row arrive from
      // two different queries, and either can still be in flight.
      if (!configured || !report) return;
      save.mutate(
        {
          /*
           * THE THREE COORDINATES ARE NOT SENT, and their absence is the point.
           *
           * This screen edits a COLUMN MAPPING. It knows the tenant's Drive
           * folder and spreadsheet only because a GET fetched them — outside any
           * transaction, possibly minutes ago while the operator worked through
           * the wizard. Echoing them back would make "Lưu ánh xạ" silently
           * revert a folder another admin moved in the meantime: the lost
           * update, with a window as long as the wizard stays open (N1, same
           * class as F3).
           *
           * `updateCatalogSource` reads an absent key as "giữ nguyên cái đang
           * lưu" and the repo merges it under its own lock, so the value that
           * survives is the one that is current at write time — not the one this
           * tab happened to read. Nothing is lost by not sending them; something
           * is lost by sending them.
           *
           * `textSourceKind` goes too, for the same reason it existed: it only
           * told the client-side guard whether the coordinates were required,
           * and there are no coordinates to guard any more.
           */
          fieldMap: payload.fieldMap,
          stockPolicy: payload.stockPolicy,
          // Phase 2. Sent on the same PUT as the map on purpose: the layout and
          // the `mediaLink` column it needs are one answer, and two writes could
          // leave a tenant with `sheet-column` stored and no column to read.
          mediaProfile: payload.mediaProfile,
          /*
           * The header row the operator actually mapped against — the same list
           * that filled the dropdowns. It lets the server repeat the
           * "cột này không còn tồn tại" check instead of trusting that the
           * browser ran it.
           *
           * `undefined` when the report came back with no columns at all (an
           * unreadable tab): the domain reads an empty list as "caller has no
           * header row" and skips the check, so sending `[]` would look like a
           * check that passed. The form refuses to save in that state anyway.
           */
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
    <Stack direction="vertical" gap={4}>
      {savedAt !== null && !save.isPending ? (
        <Banner
          status="success"
          title="Đã lưu ánh xạ cột, cách kiểm tồn và nguồn ảnh"
          description="Chạy đồng bộ ở màn “Đồng bộ dữ liệu” để hệ thống đọc lại toàn bộ bảng theo ánh xạ mới."
          isDismissable
          onDismiss={() => setSavedAt(null)}
        />
      ) : null}

      {/* `key` on the report identity: after a save the baseline is refetched,
          and the form must restart from the map that is now stored instead of
          keeping the state of a form the operator already submitted. */}
      <FieldMapForm
        key={`${report.spreadsheetId}:${report.sheetName}:${savedAt ?? 0}`}
        report={report}
        // Straight from `tenant_integration`, not from the report: the report
        // echoes whatever it was asked to compute with, while these two answer
        // "đã khai hay chưa" — and `null` there is the whole difference between
        // restoring somebody's work and offering to overwrite it.
        storedFieldMap={configured.fieldMap}
        storedStockPolicy={configured.stockPolicy}
        // `?? null` folds "server does not send the key yet" into "chưa khai",
        // which is the honest reading of both (see CatalogSourceSchema).
        storedMediaProfile={configured.mediaProfile ?? savedMediaProfile}
        isSaving={save.isPending}
        saveError={save.isError ? save.error : null}
        readOnlyReason={readOnlyReason}
        onDirtyChange={onDirtyChange}
        onSave={handleSave}
      />

      <HStack gap={2}>
        <Button variant="ghost" label="Quay lại báo cáo" onClick={onBack} />
      </HStack>
    </Stack>
  );
}

/**
 * Same blocks, same heights as the real report, so the answer lands without
 * pushing the page around (web-feedback-states rule 1). `aria-hidden` because a
 * screen reader has nothing to read in a grey box.
 */
function ReportSkeleton() {
  return (
    <Stack direction="vertical" gap={4} aria-hidden="true">
      <Skeleton height={132} />
      <Skeleton height={220} />
      <Skeleton height={160} />
    </Stack>
  );
}
