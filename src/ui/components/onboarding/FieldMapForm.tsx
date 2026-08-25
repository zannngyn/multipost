"use client";

import {
  Banner,
  Button,
  Divider,
  HStack,
  Heading,
  CheckboxInput,
  RadioList,
  RadioListItem,
  Selector,
  Stack,
  Text,
  TextArea,
  TextInput,
} from "@astryxdesign/core";
import { useEffect, useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { CompatibilityReport } from "@/ui/components/onboarding/CompatibilityReport";
import { MediaSourceFields } from "@/ui/components/onboarding/MediaSourceFields";
import {
  UNMAPPED_OPTION_VALUE,
  blockingIssues,
  columnOptions,
  isRequiredField,
  issueForField,
  priceConfirmationKey,
  priceLikeCaptionAssignments,
  warningIssues,
  stockPolicyFormFromStored,
  toStockPolicy,
  validateFieldMapValues,
  type StockPolicyFormState,
} from "@/ui/components/onboarding/field-map-form";
import {
  blockingMediaIssues,
  mediaProfileFormFromStored,
  toMediaProfile,
  validateMediaProfileForm,
  type MediaProfileFormState,
} from "@/ui/components/onboarding/media-profile-form";
import { useProfilePreview } from "@/ui/hooks/useCatalogMapping";
import {
  CATALOG_CONTENT_FIELDS,
  CATALOG_FIELDS,
  CATALOG_FIELD_HINTS,
  CATALOG_FIELD_LABELS,
  CONFIDENCE_HINTS,
  CONFIDENCE_LABELS,
  STOCK_POLICY_HINTS,
  STOCK_POLICY_LABELS,
  STOCK_POLICY_MODES,
  confidenceBand,
  type CatalogFieldMap,
  type CatalogProfileReport,
  type MediaProfileConfig,
  type StockPolicy,
  type StockPolicyMode,
} from "@/ui/schemas/catalog-mapping.schema";

/**
 * Step 3 — "Ánh xạ cột, kiểm tồn & nguồn ảnh": which column of THIS customer's
 * sheet holds which logical field, how the stock cell is read, and where their
 * photos live.
 *
 * Three parts, one save, because they are one decision: a `stock` column with no
 * policy is unreadable, a policy with no column is unusable, and the photo
 * layout is stored half inside the map itself (`fieldMap.mediaLink`), so a
 * separate step would have to send a half-map — the "mỗi bước một form riêng"
 * that core-wizard names as the source of lost data.
 *
 * The half that matters most is the smallest one. `disabled` suspends CLAUDE.md
 * business rule 3 for the whole tenant, so it is deliberately the hardest branch
 * to submit: it demands a written reason, it shows the red banner the operator
 * will meet again on every screen that displays stock, and the save button
 * refuses to fire without both.
 *
 * Nothing here decides anything about the data: the map is validated again by
 * `validateFieldMap` in the domain, and the numbers under "Xem lại số" come from
 * a real dry-run of the customer's spreadsheet, not from anything computed here.
 */
export function FieldMapForm({
  report,
  storedFieldMap,
  storedStockPolicy,
  storedMediaProfile,
  isSaving,
  saveError,
  readOnlyReason,
  onDirtyChange,
  onSave,
}: {
  /** The baseline report: the tenant's real columns and the suggestion for each. */
  report: CatalogProfileReport;
  /**
   * What the tenant DECLARED, straight from `tenant_integration` — or null when
   * it never declared anything and is running on the MYSP preset.
   *
   * `null` and "a map that happens to equal the preset" are different answers
   * and this form renders them differently: null pre-fills from the suggestion
   * and warns that saving overwrites, a value is restored as-is and warns about
   * nothing, because nothing is being guessed.
   */
  storedFieldMap: CatalogFieldMap | null;
  storedStockPolicy: StockPolicy | null;
  /**
   * Where this tenant's photos live, as DECLARED — null when nobody declared
   * anything and the built-in `MÃ-Màu (số)` convention is what runs.
   *
   * Today the server never sends it (see `CatalogSourceSchema.mediaProfile`), so
   * this is null for everybody and the form offers the report's recommendation.
   * The moment `toCatalogSourceView` puts the key on the wire, the declared kind
   * is restored here with no change on this side.
   */
  storedMediaProfile: MediaProfileConfig | null;
  isSaving: boolean;
  saveError: unknown;
  /** Set while the app is read-only (support mode, M3.3). */
  readOnlyReason: string | null;
  /** Lets the screen guard navigation while there is unsaved work. */
  onDirtyChange: (isDirty: boolean) => void;
  onSave: (payload: {
    fieldMap: CatalogFieldMap;
    stockPolicy: StockPolicy;
    mediaProfile: MediaProfileConfig;
  }) => void;
}) {
  const columns = report.sheet.columns;
  const suggestions = report.fieldMap.fields;
  /** The one fact that decides the wording of this whole step. */
  const hasStoredMap = storedFieldMap !== null;

  // The stored map wins; the suggestion is the fallback for a tenant that never
  // declared one (`report.fieldMap.fieldMap` IS that suggestion in that case,
  // because the route only forwards a stored map when there is one).
  const [values, setValues] = useState<CatalogFieldMap>(
    () => storedFieldMap ?? report.fieldMap.fieldMap,
  );
  const [stockForm, setStockForm] = useState<StockPolicyFormState>(() =>
    stockPolicyFormFromStored(storedStockPolicy),
  );
  /**
   * The photo half. `storedFieldMap?.mediaLink` and not `values.mediaLink`: the
   * initialiser must read what is STORED, and `values` may already be the
   * report's suggestion for a tenant who declared nothing.
   */
  const [mediaForm, setMediaForm] = useState<MediaProfileFormState>(() =>
    mediaProfileFormFromStored(
      storedMediaProfile,
      storedFieldMap?.mediaLink ?? null,
      report.mediaProfileSuggestion,
    ),
  );
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const isReadOnly = readOnlyReason !== null;
  /** No header row = nothing to map, and nothing to validate a map against. */
  const hasColumns = columns.length > 0;
  const preview = useProfilePreview();

  const mapIssues = useMemo(() => validateFieldMapValues(values, columns), [values, columns]);
  /*
   * Two halves, two lifecycles.
   *
   * `blockers` stop the save and are only shown once the operator has pressed it
   * — painting eight fields red before anybody typed is how a form teaches
   * people to ignore red.
   *
   * `warnings` are the opposite: a price-looking column mapped onto a caption
   * field has to be said AT THE MOMENT it is picked, because the whole point is
   * to catch it before it is stored (business rule 2). It never blocks — the
   * match is a guess about a header, and a real "Giá trị sử dụng" column must
   * stay mappable.
   */
  const blockers = useMemo(() => blockingIssues(mapIssues), [mapIssues]);
  const warnings = useMemo(() => warningIssues(mapIssues), [mapIssues]);

  /*
   * THE PRICE GATE (business rule 2, PM decision 24/08/2026).
   *
   * A yellow line was not enough. Rule 2 is a hard rule and a price in a public
   * caption is damage that cannot be taken back, so pointing a caption field at
   * a money-looking column now costs a deliberate tick before this form will
   * save. It is a speed bump, not a wall: the match is a guess about a HEADER,
   * and a tenant with a real "Giá trị sử dụng" column must still be able to map
   * it — which is why the domain was left alone and this lives here.
   *
   * The tick is stored as the KEY of what was confirmed, never as a boolean.
   * A boolean would keep vouching after the operator repointed the same field at
   * a different money column — they confirmed one column, not the checkbox.
   */
  const priceAssignments = useMemo(() => priceLikeCaptionAssignments(values), [values]);
  const priceKey = useMemo(() => priceConfirmationKey(priceAssignments), [priceAssignments]);
  const [confirmedPriceKey, setConfirmedPriceKey] = useState<string | null>(null);
  const isPriceConfirmed = priceAssignments.length === 0 || confirmedPriceKey === priceKey;
  const stockResult = useMemo(() => toStockPolicy(stockForm), [stockForm]);
  const stockIssues = stockResult.ok ? [] : stockResult.issues;
  /*
   * The media half validates against the map being EDITED, not the stored one:
   * "cột link cũng đang nuôi caption" has to react the moment somebody points a
   * caption field at it, not at the next reload.
   */
  const mediaIssues = useMemo(
    () => validateMediaProfileForm(mediaForm, columns, values),
    [mediaForm, columns, values],
  );
  const mediaBlockers = useMemo(() => blockingMediaIssues(mediaIssues), [mediaIssues]);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  /**
   * Closing the tab or reloading with unsaved changes. In-app navigation is
   * guarded by the screen (it owns the step rail) — two mechanisms, because
   * `beforeunload` does not fire for a client-side route change
   * (web-form-architecture rule 8).
   */
  useEffect(() => {
    if (!isDirty || isSaving) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, isSaving]);

  function setField(field: (typeof CATALOG_FIELDS)[number], next: string | null) {
    setIsDirty(true);
    setValues((current) => ({
      ...current,
      [field]: next === null || next === UNMAPPED_OPTION_VALUE ? null : next,
    }));
  }

  function setStock(patch: Partial<StockPolicyFormState>) {
    setIsDirty(true);
    setStockForm((current) => ({ ...current, ...patch }));
  }

  function setMedia(patch: Partial<MediaProfileFormState>) {
    setIsDirty(true);
    setMediaForm((current) => ({ ...current, ...patch }));
  }

  /**
   * The one payload both buttons send.
   *
   * `mediaLink` is merged in here rather than kept in `values`: the column map
   * on screen is about caption/stock fields, and the link column belongs to the
   * photo question. It is sent whatever the chosen layout is — dropping it when
   * the layout does not read it would delete the only thing that lets the next
   * report SCORE the `sheet-column` option.
   */
  function buildPayload(policy: StockPolicy) {
    return {
      fieldMap: { ...values, mediaLink: mediaForm.mediaLinkColumn },
      stockPolicy: policy,
      mediaProfile: toMediaProfile(mediaForm, storedMediaProfile),
    };
  }

  function runPreview() {
    setHasSubmitted(true);
    if (!hasColumns) return;
    // A preview with a broken map would report "0 mã đọc được" and read as a
    // verdict on the customer's data instead of on the form.
    if (blockers.length > 0 || mediaBlockers.length > 0 || !stockResult.ok) return;
    preview.mutate(buildPayload(stockResult.policy));
  }

  function submit() {
    setHasSubmitted(true);
    if (!hasColumns) return;
    if (blockers.length > 0 || mediaBlockers.length > 0 || !stockResult.ok) return;
    // The tick is checked HERE too, not only on the button: a disabled button is
    // a hint, and this is the last line before a price column becomes the map
    // every future sync reads.
    if (!isPriceConfirmed) return;
    onSave(buildPayload(stockResult.policy));
    setIsDirty(false);
  }

  const showIssues = hasSubmitted;
  const previewReport = preview.data?.state === "profiled" ? preview.data.report : null;

  return (
    <Stack direction="vertical" gap={5}>
      {/*
        Two different situations, two different sentences — and the difference is
        whether anything on this screen is a GUESS.

        Declared: the boxes hold what this tenant chose, so there is nothing to
        warn about and the line is a quiet fact. Never declared: the boxes hold
        the system's guess from the header row, and saving turns a guess into the
        thing every sync reads — which the operator has to be told BEFORE they
        press it, not after (business rule 5).
      */}
      {hasStoredMap ? (
        <Text type="supporting">
          Đang hiển thị ánh xạ đơn vị này đã lưu. Sửa ô nào thì chỉ ô đó đổi; bấm “Lưu ánh xạ” mới
          ghi lại.
        </Text>
      ) : (
        <Banner
          status="info"
          title="Đơn vị này chưa khai ánh xạ — các ô dưới là gợi ý tự động"
          description="Hệ thống đoán từ tên cột trên bảng tính của bạn và đang chạy theo mẫu mặc định. Kiểm tra từng dòng rồi bấm Lưu để chốt — từ lúc đó mọi lần đồng bộ đọc theo ánh xạ này."
        />
      )}

      <ReadOnlyNotice reason={readOnlyReason} />

      {/*
        Summary at the TOP of the form, not only inline on each field
        (core-form-architecture §tóm tắt lỗi đầu form): with eight dropdowns the
        broken one can be a screen away, and a save that "did nothing" with the
        reason below the fold is a save the operator will try three more times.
        `role="alert"` so it is announced, not just drawn.
      */}
      {showIssues && blockers.length + mediaBlockers.length > 0 ? (
        <Banner
          status="error"
          title={`Chưa lưu được: ${blockers.length + mediaBlockers.length} ô cần sửa`}
          description="Mỗi ô bên dưới có ghi rõ vấn đề của nó. Sửa xong bấm “Lưu ánh xạ” lại."
          role="alert"
        />
      ) : null}

      {/*
        Not gated on submit, and deliberately louder than the inline note under
        the field: this is the last screen before a price column can reach a
        public caption (business rule 2). Saving is still allowed — the match is
        a guess about a header, not a verdict — so the wording asks rather than
        refuses.
      */}
      {warnings.length > 0 ? (
        <Banner
          status="warning"
          title="Có cột trông như cột GIÁ đang được gán vào caption"
          description={warnings.map((issue) => issue.message).join(" ")}
          // Expanded: the confirmation below is the point of the banner, and a
          // gate hidden behind a toggle is a gate nobody meets.
          defaultIsExpanded
        >
          {/*
            The speed bump. Not a second warning — a control the operator has to
            touch, naming the columns they are vouching for so the sentence is
            about THEIR data and not about a rule in the abstract.
          */}
          <CheckboxInput
            label="Tôi đã kiểm tra: các cột trên không chứa giá tiền"
            description={`Xác nhận cho: ${priceAssignments
              .map((entry) => `“${entry.column}” → ${CATALOG_FIELD_LABELS[entry.field]}`)
              .join(" · ")}. Nội dung các cột này sẽ đi thẳng vào caption và hiện ra với khách.`}
            value={isPriceConfirmed}
            isDisabled={isReadOnly || isSaving}
            disabledMessage={readOnlyReason ?? undefined}
            // Ticking stores WHAT was confirmed; unticking forgets it. Repointing
            // a field at another money column changes the key and asks again.
            onChange={(checked) => setConfirmedPriceKey(checked ? priceKey : null)}
          />
        </Banner>
      ) : null}

      {/* --- Columns ------------------------------------------------------ */}
      <Stack direction="vertical" gap={3}>
        <Stack direction="vertical" gap={1}>
          <Heading level={3}>Cột nào của bạn là gì</Heading>
          <Text type="supporting">
            Chỉ những cột bạn chọn ở đây mới được đọc. Cột không chọn là vô hình với hệ thống — đó
            cũng là cách giá và ghi chú nội bộ không bao giờ lọt vào caption.
          </Text>
        </Stack>

        {columns.length === 0 ? (
          <Banner
            status="error"
            title="Chưa đọc được dòng tiêu đề của bảng tính"
            description="Không có cột nào để chọn. Kiểm tra lại tên tab và quyền chia sẻ ở bước “Nguồn dữ liệu”, rồi chạy lại báo cáo."
          />
        ) : (
          CATALOG_FIELDS.map((field) => {
            const suggestion = suggestions.find((entry) => entry.field === field);
            const band = suggestion ? confidenceBand(suggestion) : "none";
            // A blocker only after a press; a warning the moment it is true.
            const issue =
              (showIssues ? issueForField(blockers, field) : null) ??
              issueForField(warnings, field);
            const goesIntoCaption = CATALOG_CONTENT_FIELDS.includes(field);

            return (
              <Selector
                key={field}
                label={CATALOG_FIELD_LABELS[field]}
                isRequired={isRequiredField(field)}
                isOptional={!isRequiredField(field)}
                // One string, on purpose: the hint, whether it reaches a
                // caption, and how sure the suggestion is are all things the
                // operator needs BEFORE opening the list — and a colour-only
                // confidence chip would say none of it (Named Status Rule).
                //
                // The confidence line is dropped once a map is STORED: it grades
                // the system's guess, and printing "Khớp rõ" next to a column a
                // human chose reads as the system approving their work.
                description={[
                  CATALOG_FIELD_HINTS[field],
                  goesIntoCaption ? "Nội dung cột này sẽ đi vào caption." : null,
                  hasStoredMap ? null : `Gợi ý: ${CONFIDENCE_LABELS[band]} — ${CONFIDENCE_HINTS[band]}`,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" ")}
                options={columnOptions(field, columns, values)}
                value={values[field] ?? UNMAPPED_OPTION_VALUE}
                onChange={(next) => setField(field, next)}
                // Named, not left to the library default: a required field with
                // no stored column shows the placeholder, and "Select…" is the
                // one string on this screen that would come back in English.
                placeholder="Chọn cột trên bảng của bạn…"
                hasSearch={columns.length > 8}
                searchPlaceholder="Tìm tên cột…"
                isDisabled={isReadOnly || isSaving}
                disabledMessage={readOnlyReason ?? undefined}
                status={
                  issue ? { type: issue.severity, message: issue.message } : undefined
                }
                statusVariant="detached"
                width="100%"
              />
            );
          })
        )}
      </Stack>

      <Divider />

      {/* --- Stock policy -------------------------------------------------- */}
      <Stack direction="vertical" gap={3}>
        <Stack direction="vertical" gap={1}>
          <Heading level={3}>Đọc ô tồn kho thế nào</Heading>
          <Text type="supporting">
            Hệ thống kiểm tồn hai lần cho mỗi bài: lúc soạn và ngay trước khi đăng. Chọn cách đọc
            đúng với bảng của bạn, nếu không mọi mã sẽ bị chặn oan.
          </Text>
        </Stack>

        <RadioList
          label="Cách đọc ô tồn kho"
          value={stockForm.mode}
          onChange={(next) => setStock({ mode: next as StockPolicyMode })}
          isDisabled={isReadOnly || isSaving}
          disabledMessage={readOnlyReason ?? undefined}
        >
          {STOCK_POLICY_MODES.map((mode) => (
            <RadioListItem
              key={mode}
              value={mode}
              label={STOCK_POLICY_LABELS[mode]}
              description={STOCK_POLICY_HINTS[mode]}
            />
          ))}
        </RadioList>

        {stockForm.mode === "textual" ? (
          <Stack direction="vertical" gap={3}>
            <TextInput
              label="Giá trị nghĩa là CÒN hàng"
              description="Cách nhau bằng dấu phẩy. Không phân biệt hoa thường và dấu."
              value={stockForm.inStockText}
              onChange={(next) => setStock({ inStockText: next })}
              isDisabled={isReadOnly || isSaving}
              placeholder="còn hàng, còn, sẵn hàng"
              width="100%"
            />
            <TextInput
              label="Giá trị nghĩa là HẾT hàng"
              description="Giá trị không nằm trong hai danh sách sẽ bị CHẶN — hệ thống không đoán."
              value={stockForm.outOfStockText}
              onChange={(next) => setStock({ outOfStockText: next })}
              isDisabled={isReadOnly || isSaving}
              placeholder="hết hàng, hết, ngừng bán"
              width="100%"
            />
          </Stack>
        ) : null}

        {stockForm.mode === "disabled" ? (
          <Stack direction="vertical" gap={3}>
            {/* Red, and shown BEFORE the field, not after the save: the operator
                has to know what they are turning off while they type the
                reason for turning it off. */}
            <Banner
              status="error"
              title="Chọn mục này là bỏ chốt chặn theo SỐ TỒN"
              description="Ô tồn trống, bằng 0 hay không phải số sẽ không còn chặn ở bất kỳ bước nào — soạn bài, duyệt, hay lúc đăng. Vẫn chặn như thường: ô Lưu ý ghi “HẾT HÀNG”, và mã có nhiều dòng dữ liệu khác nhau. Mọi màn hình có tồn kho sẽ hiện cảnh báo đỏ kèm lý do bạn ghi dưới đây."
            />
            <TextArea
              label="Vì sao đơn vị này không cần kiểm tồn kho?"
              description="Ít nhất 10 ký tự. Lý do được ghi vào nhật ký và hiện cho mọi người vận hành."
              value={stockForm.disabledReason}
              onChange={(next) => setStock({ disabledReason: next })}
              isRequired
              rows={3}
              maxLength={500}
              isDisabled={isReadOnly || isSaving}
              placeholder="Ví dụ: tồn kho quản lý trên phần mềm bán hàng, bảng này chỉ dùng để đăng bài."
              width="100%"
            />
          </Stack>
        ) : null}

        {showIssues && stockIssues.length > 0 ? (
          <Banner
            status="error"
            title="Chưa lưu được phần kiểm tồn"
            description={stockIssues.join(" ")}
          />
        ) : null}
      </Stack>

      <Divider />

      {/* --- Media source -------------------------------------------------- */}
      <MediaSourceFields
        report={report}
        storedKind={storedMediaProfile?.kind ?? null}
        state={mediaForm}
        // Blockers only after a press, warnings the moment they are true — the
        // same two lifecycles the column map uses, for the same reason.
        issues={showIssues ? mediaIssues : mediaIssues.filter((issue) => issue.severity !== "error")}
        isDisabled={isReadOnly || isSaving}
        disabledMessage={readOnlyReason ?? undefined}
        onChange={setMedia}
      />

      <Divider />

      {/* --- Actions ------------------------------------------------------- */}
      <Stack direction="vertical" gap={2}>
        <HStack gap={2} wrap="wrap" align="center">
          <Button
            variant="primary"
            label={isSaving ? "Đang lưu…" : "Lưu ánh xạ"}
            isLoading={isSaving}
            // No header row means nothing was mapped against anything: saving
            // there would also send the server no column list, and the domain
            // reads an absent list as "cannot check" — a save that looks
            // validated and was not.
            isDisabled={isReadOnly || isSaving || !hasColumns || !isPriceConfirmed}
            tooltip={
              readOnlyReason ??
              (!hasColumns
                ? "Chưa đọc được cột nào trên bảng tính — sửa nguồn dữ liệu rồi chạy lại báo cáo."
                : !isPriceConfirmed
                  ? "Tích xác nhận ở khối cảnh báo phía trên trước đã — có cột trông như cột giá đang gán vào caption."
                  : undefined)
            }
            onClick={submit}
          />
          {/* The whole point of step 3: change the map, see the number move,
              before committing anything. Read-only, so it stays available in
              support mode — looking is exactly what support mode is for. */}
          <Button
            variant="secondary"
            label={preview.isPending ? "Đang đọc lại bảng tính…" : "Xem lại số với ánh xạ này"}
            isLoading={preview.isPending}
            isDisabled={preview.isPending || isSaving}
            onClick={runPreview}
          />
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {isSaving
            ? "Đang lưu ánh xạ cột"
            : preview.isPending
              ? "Đang chạy lại báo cáo tương thích"
              : !isPriceConfirmed
                ? "Chưa lưu được: cần tích xác nhận cột trông như cột giá ở phía trên."
                : isDirty
                  ? "Có thay đổi chưa lưu."
                  : ""}
        </Text>

        <Text type="supporting">
          Lưu ánh xạ KHÔNG chạy đồng bộ. Dữ liệu trong hệ thống vẫn là của lần đồng bộ trước cho
          tới khi bạn chạy lại ở màn “Đồng bộ dữ liệu”.
        </Text>
      </Stack>

      {saveError ? <ApiErrorNotice error={saveError} source="Lưu ánh xạ" /> : null}
      {preview.isError ? (
        <ApiErrorNotice error={preview.error} onRetry={runPreview} source="Báo cáo thử" />
      ) : null}

      {previewReport ? (
        <Stack direction="vertical" gap={2}>
          <Divider />
          <Heading level={3}>Kết quả với ánh xạ đang sửa</Heading>
          <Text type="supporting">
            Đây là bản chạy thử — chưa có gì được lưu. Bấm “Lưu ánh xạ” nếu con số này là cái bạn
            muốn.
          </Text>
          <CompatibilityReport report={previewReport} headingLevel={3} />
        </Stack>
      ) : null}
    </Stack>
  );
}
