"use client";

import {
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  SegmentedControl,
  SegmentedControlItem,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { AccessRequestTable } from "@/ui/components/access/AccessRequestTable";
import { AccessRequestTableSkeleton } from "@/ui/components/access/AccessRequestTableSkeleton";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { TAB_PARAM, withTabParam } from "@/ui/components/navigation/tab-param";
import { useAccessRequests } from "@/ui/hooks/useAccessRequests";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import {
  ACCESS_FILTER_LABELS,
  ACCESS_FILTER_STATUSES,
  accessSearchParams,
  parseAccessFilterStatus,
  type AccessFilterStatus,
  type AccessRequest,
} from "@/ui/schemas/access-request.schema";

/**
 * "Lịch sử duyệt" (E10, retired by M2.4): who once asked to sign in, and what
 * was decided about them.
 *
 * READ-ONLY since M2.4. The approval queue is retired: people are added with an
 * invite link on the "Thành viên" screen, which is both faster (no waiting for
 * an admin to notice) and safer (the inviter picks the role up front). The rows
 * stay because they are the AUDIT TRAIL of every account ever let in or
 * refused — retiring a flow is not a reason to delete its history.
 *
 * Since the wave-1 IA this is a PANEL of the "Thành viên" hub
 * (`/members?tab=history`), not a page of its own: the hub owns the frame, the
 * page's h1 and the tab strip, so this panel starts at h2, its list section at
 * h3 and its empty boxes at h4 (core-accessibility §1 — one h1 per page, no
 * level skipped). `/access` redirects here, query and all.
 *
 * The filter lives in the URL (core-data-list-query rule 1): `/members?tab=
 * history&status=blocked` is shareable, survives F5 and makes Back behave. One
 * builder writes it, one parser reads it, and the query key is derived from the
 * same value. The default ("chờ duyệt") is NOT written to the URL — but the
 * hub's `?tab=` IS carried through every rewrite, or changing the filter would
 * throw the operator back to the member list.
 *
 * The four mandatory states live in `AccessRequestsBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per request; no actions, because there are none left
 *   empty   — told apart on purpose: "không có ai chờ duyệt" (good news, the
 *             queue is clear) is a different sentence from "chưa có yêu cầu
 *             nào" (nobody has ever tried to sign in). One box for both would
 *             make an admin think the list was lost
 *   error   — 4xx (không thử lại được) vs 5xx (thử lại), via `presentApiError`
 */
export function AccessRequestsScreen({
  /**
   * Takes the operator to the tab that can actually add someone — "Link mời",
   * the successor of this retired queue, NOT the member list (which only shows
   * people who are already in). A tab switch, not a navigation: both views live
   * on the same address now.
   */
  onGoToInvites,
}: {
  onGoToInvites: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = useMemo(
    () => parseAccessFilterStatus(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const requests = useAccessRequests(status);

  const items = requests.data?.items ?? [];
  const isFirstLoad = requests.isPending && requests.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const selectStatus = useCallback(
    (value: string) => {
      const next = value as AccessFilterStatus;
      // This panel rebuilds the WHOLE query from its own builder, so the hub's
      // `?tab=` has to be carried back in by hand — without it the next render
      // reads no tab, falls back to "members" and the history disappears
      // mid-filter. The raw value is carried, not re-normalised: an unknown tab
      // already renders the default panel.
      const query = withTabParam(accessSearchParams(next).toString(), searchParams.get(TAB_PARAM));
      // `replace`: switching a filter is not a navigation step to walk back to.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );



  return (
    <Stack direction="vertical" height="100%">
      <Stack direction="vertical" gap={3} paddingInline={4} paddingBlock={3}>
        <Stack direction="vertical" gap={1}>
          {/* h2: the hub above owns the page's h1 (core-accessibility §1). */}
          <Heading level={2}>Lịch sử duyệt</Heading>
          <Text type="supporting">
            Lưu lại những tài khoản từng xin vào hệ thống theo luồng chờ duyệt cũ, ai quyết định và
            lúc nào. Tab này chỉ để tra cứu — không thao tác được nữa.
          </Text>
        </Stack>

        <HStack gap={3} align="center" wrap="wrap">
          <SegmentedControl
            label="Lọc theo trạng thái yêu cầu"
            value={status}
            onChange={selectStatus}
            size="sm"
          >
            {ACCESS_FILTER_STATUSES.map((value) => (
              <SegmentedControlItem key={value} value={value} label={ACCESS_FILTER_LABELS[value]} />
            ))}
          </SegmentedControl>

          <Button
            variant="secondary"
            size="sm"
            label={requests.isFetching ? "Đang tải…" : "Tải lại"}
            isDisabled={requests.isFetching}
            onClick={() => void requests.refetch()}
          />
        </HStack>
      </Stack>

      {/* Said once, at the top, instead of a row of disabled buttons: the
          operator needs to know WHERE the flow moved, not that this panel is
          dead. `info`, not `warning` — nothing is broken. */}
      <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
        <Banner
          status="info"
          title="Luồng duyệt đã nghỉ hưu"
          description="Giờ thêm người bằng link mời ở tab “Link mời”: bạn chọn sẵn vai trò, gửi link, người nhận đăng nhập là vào thẳng công ty. Bảng dưới đây được giữ lại để tra cứu lịch sử."
          endContent={
            // The button has to land where the sentence above points: sending
            // the operator to the member list would leave them looking for an
            // invite form that lives one tab further on.
            <Button variant="secondary" size="sm" label="Mở tab Link mời" onClick={onGoToInvites} />
          }
        />
      </Stack>

      <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
        <Heading level={3}>Lịch sử yêu cầu</Heading>
        {/* Only once the list is real: "0 yêu cầu" while loading reads as an
            answer, and an admin would act on it. */}
        {requests.data ? (
          <Text type="supporting" role="status" aria-live="polite">
            {items.length} yêu cầu · {ACCESS_FILTER_LABELS[status].toLowerCase()}
          </Text>
        ) : null}
      </HStack>

      <StackItem size="fill">
        <AccessRequestsBody
          status={status}
          isFirstLoad={isFirstLoad}
          showSkeleton={showSkeleton}
          isError={requests.isError}
          error={requests.error}
          onRetry={() => void requests.refetch()}
          onShowAll={() => selectStatus("all")}
          items={items}
        />
      </StackItem>
    </Stack>
  );
}

function AccessRequestsBody({
  status,
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  onShowAll,
  items,
}: {
  status: AccessFilterStatus;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onShowAll: () => void;
  items: readonly AccessRequest[];
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <AccessRequestTableSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // --- Empty: three different situations, three different sentences ---------
  if (items.length === 0) {
    if (status === "pending") {
      // Nothing is waiting, and nothing ever will again — the queue is retired.
      // Saying "chưa có ai chờ duyệt" alone would leave someone waiting for a
      // row that is never coming (core-feedback-states §Empty, kind "done").
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={4}
            title="Không còn ai chờ duyệt"
            description="Luồng chờ duyệt đã nghỉ hưu nên sẽ không có yêu cầu mới nào xuất hiện ở đây. Muốn thêm người, hãy tạo link mời ở tab “Link mời”."
            actions={
              <Button variant="secondary" label="Xem tất cả lịch sử" onClick={onShowAll} />
            }
          />
        </Stack>
      );
    }

    if (status === "all") {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={4}
            title="Chưa có yêu cầu nào trong lịch sử"
            description="Không tài khoản nào từng đi qua luồng chờ duyệt của đơn vị này. Ai đang ở trong công ty thì xem ở tab “Thành viên”; muốn thêm người mới thì tạo link mời ở tab “Link mời”."
          />
        </Stack>
      );
    }

    // Filtered out, not lost: the data may well exist under another filter.
    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={4}
          title={`Không có yêu cầu nào ở trạng thái “${ACCESS_FILTER_LABELS[status]}”`}
          description="Dữ liệu vẫn còn nguyên — chỉ là không có ai ở trạng thái đang lọc. Xem tất cả để đối chiếu."
          actions={<Button variant="secondary" label="Xem tất cả lịch sử" onClick={onShowAll} />}
        />
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // The dangerous case: a refetch failed while rows from an earlier answer are
  // still on screen. Hiding that would let an admin approve against a list the
  // server no longer agrees with. The rows stay (still the best information we
  // have) and the failure is said out loud, with a way to try again.
  return (
    <Stack direction="vertical" height="100%">
      {isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <Banner
            status="warning"
            title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
            description={`${presentApiError(toApiError(error)).description} Những gì đang hiện là kết quả của lần tải gần nhất; hãy thử lại trước khi tra cứu.`}
            endContent={<Button variant="secondary" size="sm" label="Thử lại" onClick={onRetry} />}
          />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <AccessRequestTable items={items} />
      </StackItem>
    </Stack>
  );
}
