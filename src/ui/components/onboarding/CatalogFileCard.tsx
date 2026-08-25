"use client";

import {
  Badge,
  Banner,
  Button,
  FileInput,
  HStack,
  Heading,
  List,
  ListItem,
  Section,
  Stack,
  Table,
  Text,
} from "@astryxdesign/core";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import {
  CATALOG_FILE_EXPORT_STEPS,
  CATALOG_FILE_RULE,
  UPLOADED_FILE_IS_A_COPY,
  describeDelimiter,
  describeUploadedFile,
} from "@/ui/components/onboarding/catalog-source-choice";
import type { CatalogTextSource } from "@/ui/schemas/catalog-mapping.schema";
import {
  CATALOG_FILE_ACCEPT,
  MAX_CATALOG_FILE_BYTES,
  formatFileBytes,
  type CatalogFilePreview,
} from "@/ui/schemas/catalog.schema";

/**
 * "Tải file CSV lên" — step 1 of "Kết nối dữ liệu" for a tenant with no Google
 * Workspace, or whose spreadsheet is too far from anything syncable.
 *
 * THE THREE THINGS THIS CARD OWES THE OPERATOR
 *
 * 1. THE RULE BEFORE THE PICKER. "Chỉ đọc CSV" and the two export menus are
 *    above the file button, not in an error underneath it. `accept` greys out
 *    the wrong files in the dialog, but `accept` is a hint no screen reader
 *    reads aloud and no operator sees before they go looking — the sentence is
 *    what actually prevents the wasted trip through Excel.
 * 2. WHICH FILE, AND WHEN. After an upload the card names the file and the
 *    minute it arrived, permanently, plus the one sentence that answers the
 *    question this feature creates: the server holds a COPY, so editing the
 *    file on their laptop changes nothing until they upload again.
 * 3. WHAT THE READER SAW. Row count, columns, the separator it had to GUESS,
 *    and every notice — dropped blank rows, ragged rows, a `sep=` line Excel
 *    added. A reader that silently discarded three rows is exactly the failure
 *    business rule 5 forbids.
 *
 * Presentational by contract: it takes the mutation's state and hands the chosen
 * File up through `onUpload`. It never fetches, and it never decides whether the
 * file is usable — the server reads the bytes through the same adapter the next
 * sync will use, and refuses with its own sentence naming the fix.
 */
export function CatalogFileCard({
  textSource,
  preview,
  isUploading,
  error,
  readOnlyReason,
  onUpload,
}: {
  /** The stored source. `file` = something was uploaded before. */
  textSource: CatalogTextSource | null | undefined;
  /** The reader's report for the file JUST uploaded; null before any upload. */
  preview: CatalogFilePreview | null;
  isUploading: boolean;
  error: unknown;
  readOnlyReason: string | null;
  onUpload: (file: File) => void;
}) {
  /**
   * The chosen file, before it is sent. NOT derived from the mutation: a
   * refusal must leave the operator's choice on screen so "Thử lại" is one
   * press, not another trip through the file dialog (core-file-upload §lỗi
   * không làm mất tệp đã chọn).
   */
  const [picked, setPicked] = useState<File | null>(null);
  const stored = describeUploadedFile(textSource);
  const isBlocked = isUploading || Boolean(readOnlyReason);

  return (
    <Stack direction="vertical" gap={3}>
      {/*
        WHAT IS BEING READ RIGHT NOW, first — before the picker that would
        replace it. An operator who is about to upload needs to know what they
        are overwriting, and one who came back to check "sao số không đổi" needs
        this line and nothing else.
      */}
      {stored ? (
        <Banner
          status="success"
          title={`Đang đọc file “${stored.fileName}”`}
          description={[
            stored.uploadedAt ? `Tải lên lúc ${stored.uploadedAt}.` : null,
            stored.sizeLabel ? `Dung lượng ${stored.sizeLabel}.` : null,
            UPLOADED_FILE_IS_A_COPY,
          ]
            .filter((part): part is string => part !== null)
            .join(" ")}
        />
      ) : null}

      <Stack direction="vertical" gap={1}>
        <Heading level={3}>Tải bảng sản phẩm dạng CSV</Heading>
        <Text type="supporting">
          Dùng khi đơn vị không dùng Google Sheet, hoặc muốn gửi bảng sản phẩm một lần để hệ thống
          đọc thử. Ảnh vẫn có thể để trên Drive như bình thường.
        </Text>
      </Stack>

      {/*
        THE RULE, above the picker. `status="warning"`, not `error`: nothing has
        gone wrong yet — this is the thing that stops it going wrong.
      */}
      <Banner
        status="warning"
        title={CATALOG_FILE_RULE}
        description="Cách xuất file đúng định dạng:"
        /*
          `defaultIsExpanded`, and it is load-bearing: Banner collapses its
          children behind an "Expand" toggle by default, which put the export
          instructions one click AWAY from the operator who needs them. The whole
          reason this block sits above the picker is that nobody should have to
          go looking — a hidden instruction is the same as a missing one.
        */
        defaultIsExpanded
      >
        <List>
          {CATALOG_FILE_EXPORT_STEPS.map((step) => (
            <ListItem key={step} label={step} />
          ))}
        </List>
      </Banner>

      <ReadOnlyNotice reason={readOnlyReason} />

      <FileInput
        label="File bảng sản phẩm (.csv)"
        description={`Tối đa ${formatFileBytes(MAX_CATALOG_FILE_BYTES)}. Kéo thả file vào đây, hoặc bấm để chọn.`}
        mode="dropzone"
        // A HINT for the picker dialog only — the server reads the bytes, so an
        // .xlsx renamed to .csv is still caught and still explained.
        accept={CATALOG_FILE_ACCEPT}
        maxSize={MAX_CATALOG_FILE_BYTES}
        value={picked}
        onChange={(files) => setPicked(Array.isArray(files) ? (files[0] ?? null) : files)}
        isDisabled={isBlocked}
        disabledMessage={readOnlyReason ?? undefined}
        isLoading={isUploading}
      />

      {/*
        Not a field-level problem: an .xlsx, a non-UTF-8 export, a header-only
        file. The server names the fix in its own sentence; `presentApiError`
        already refuses a retry button for a 4xx, because re-sending the same
        bytes produces the same refusal.
      */}
      {error ? <ApiErrorNotice error={error} shouldFocus={false} source="Tải file lên" /> : null}

      <HStack gap={2} wrap="wrap" align="center">
        <Button
          variant="primary"
          label={isUploading ? "Đang đọc file…" : "Tải lên và đọc thử"}
          isLoading={isUploading}
          // Never disabled for "no file chosen": a button that does nothing
          // teaches nothing (core-form-architecture). Pressing it with no file
          // produces the client guard's sentence, which names what to do.
          isDisabled={isBlocked}
          tooltip={readOnlyReason ?? undefined}
          onClick={() => {
            if (picked) onUpload(picked);
          }}
        />
        <Text type="supporting">
          Hệ thống đọc file NGAY khi tải lên — sai định dạng thì báo tại đây, không đợi tới lúc đồng
          bộ.
        </Text>
      </HStack>

      {preview ? <FilePreviewPanel preview={preview} /> : null}
    </Stack>
  );
}

/**
 * Columns in the sample TABLE. The full header list is printed above it as
 * text, so this cap hides no information — it only stops a thirty-column price
 * list from rendering as an unreadable strip.
 */
const MAX_PREVIEW_COLUMNS = 8;

/**
 * What the reader actually saw. This is the operator's chance to catch a file
 * that "uploaded fine" but was read wrong — shifted columns from a guessed
 * separator, a header row that is really the first product, rows quietly
 * dropped.
 */
function FilePreviewPanel({ preview }: { preview: CatalogFilePreview }) {
  const separator = describeDelimiter(preview.delimiter, preview.delimiterDetected);
  const recognised = preview.fieldMapSuggestion.fields.filter((field) => field.column !== null);
  const shownColumns = preview.columns.slice(0, MAX_PREVIEW_COLUMNS);
  const hiddenColumnCount = preview.columns.length - shownColumns.length;

  return (
    <Section variant="muted" padding={3}>
      <Stack direction="vertical" gap={3}>
        <Stack direction="vertical" gap={1}>
          <Heading level={4}>Đã đọc được file</Heading>
          <Text type="supporting">
            {`${preview.rowCount.toLocaleString("vi-VN")} dòng sản phẩm · ${preview.columns.length} cột`}
            {preview.encoding ? ` · bảng mã ${preview.encoding}` : ""}
          </Text>
        </Stack>

        {separator ? <Text type="supporting">{separator}</Text> : null}

        {/*
          Every deviation, grouped and counted by the reader. NOT errors — the
          file was read — but a row it dropped without saying so is exactly the
          silence business rule 5 bans.
        */}
        {preview.notices.length > 0 ? (
          <Banner
            status="info"
            title={`${preview.notices.length} điều cần biết về file này`}
            description="File vẫn đọc được. Xem qua để chắc chắn không mất dòng nào ngoài ý muốn."
            // Expanded for the same reason: a row the reader dropped is exactly
            // what must not sit behind a toggle (business rule 5).
            defaultIsExpanded
          >
            <List>
              {preview.notices.map((notice) => (
                <ListItem key={notice.code} label={notice.detail} />
              ))}
            </List>
          </Banner>
        ) : null}

        {/*
          A SUGGESTION, and labelled as one. Step 3 is where a map is chosen and
          saved; showing what was recognised here only saves the operator from
          wondering whether the upload understood anything at all.
        */}
        <Stack direction="vertical" gap={1}>
          <Text weight="semibold">
            {recognised.length > 0
              ? `Nhận diện được ${recognised.length} cột theo tên`
              : "Chưa nhận diện được cột nào theo tên"}
          </Text>
          <Text type="supporting">
            {recognised.length > 0
              ? "Đây mới là gợi ý. Bạn xác nhận và sửa lại ở bước “Ánh xạ cột”."
              : "Không sao — bạn chọn tay từng cột ở bước “Ánh xạ cột”."}
          </Text>
          {preview.fieldMapSuggestion.priceLikeColumns.length > 0 ? (
            <Text type="supporting">
              {`Các cột trông như giá (${preview.fieldMapSuggestion.priceLikeColumns.join(", ")}) sẽ KHÔNG được đọc trừ khi bạn tự khai — giá không bao giờ vào caption.`}
            </Text>
          ) : null}
        </Stack>

        {/*
          EVERY column name, as text. The sample table below shows only the
          first few — a price list with thirty columns would be unreadable — but
          the operator has to be able to check that the whole header row was
          understood, so the full list is never the thing that gets cut.
        */}
        <Stack direction="vertical" gap={1}>
          <Text weight="semibold">{`${preview.columns.length} cột đọc được`}</Text>
          <Text type="code">{preview.columns.join(" · ")}</Text>
        </Stack>

        {preview.sampleRows.length > 0 ? (
          <Stack direction="vertical" gap={1}>
            <Text weight="semibold">{`${preview.sampleRows.length} dòng đầu tiên`}</Text>
            <Text type="supporting">
              Kiểm tra chữ tiếng Việt có dấu hiển thị đúng, và các cột có nằm đúng chỗ không. Chữ
              hiện thành “Vßy hoa nhÝ” nghĩa là file chưa lưu bảng mã UTF-8.
            </Text>
            <Table
              data={preview.sampleRows}
              columns={shownColumns.map((column) => ({ key: column, header: column }))}
              density="compact"
              textOverflow="truncate"
            />
            {hiddenColumnCount > 0 ? (
              <Text type="supporting">
                {`Bảng xem trước hiển thị ${shownColumns.length} cột đầu; ${hiddenColumnCount} cột còn lại vẫn được đọc và có trong danh sách bên trên.`}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        {/*
          The one thing an operator reliably assumes and that is NOT true:
          uploading is not importing. Nothing in the product list changes until
          a sync runs.
        */}
        <HStack gap={2} align="center" wrap="wrap">
          <Badge variant="info" label="Chưa đồng bộ" />
          <Text type="supporting">
            File đã được lưu, nhưng danh sách sản phẩm chỉ đổi sau khi bạn chạy đồng bộ ở màn “Đồng
            bộ dữ liệu”.
          </Text>
        </HStack>
      </Stack>
    </Section>
  );
}
