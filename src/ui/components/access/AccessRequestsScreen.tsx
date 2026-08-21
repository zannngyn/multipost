"use client";

import {
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
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
 * Frame (`astryx docs layout`, tracker archetype): header carries the title and
 * the reload action, a toolbar row carries the filter and the result count, and
 * the content region carries the rows edge-to-edge.
 *
 * The filter lives in the URL (core-data-list-query rule 1): `/access?status=
 * blocked` is shareable, survives F5 and makes Back behave. One builder writes
 * it, one parser reads it, and the query key is derived from the same value.
 * The default ("chờ duyệt") is NOT written to the URL.
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
export function AccessRequestsScreen() {
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
      const query = accessSearchParams(next).toString();
      // `replace`: switching a filter is not a navigation step to walk back to.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );



  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          {/* Title left, actions right. The status filter is NOT here: it
              belongs beside the rows it filters, in the toolbar below. */}
          <HStack gap={4} padding={4} justify="between" align="start" wrap="wrap">
            <Stack direction="vertical" gap={1} maxWidth={640}>
              <Heading level={1}>Lịch sử duyệt</Heading>
              <Text type="supporting">
                Lưu lại những tài khoản từng xin vào hệ thống theo luồng chờ duyệt cũ, ai quyết
                định và lúc nào. Màn này chỉ để tra cứu — không thao tác được nữa.
              </Text>
            </Stack>

            <Button
              variant="secondary"
              size="sm"
              label={requests.isFetching ? "Đang tải…" : "Tải lại"}
              isDisabled={requests.isFetching}
              onClick={() => void requests.refetch()}
            />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* Said once, at the top, instead of a row of disabled buttons:
                the operator needs to know WHERE the flow moved, not that this
                screen is dead. `info`, not `warning` — nothing is broken. */}
            <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
              <Banner
                status="info"
                title="Luồng duyệt đã nghỉ hưu"
                description="Giờ thêm người bằng link mời ở màn Thành viên: bạn chọn sẵn vai trò, gửi link, người nhận đăng nhập là vào thẳng công ty. Bảng dưới đây được giữ lại để tra cứu lịch sử."
                endContent={
                  <Button
                    variant="secondary"
                    size="sm"
                    label="Mở màn Thành viên"
                    onClick={() => router.push("/members")}
                  />
                }
              />
            </Stack>

            {/* Toolbar: the filter sits with the rows it filters, and the
                result count sits with the filter that produced it — so an
                empty table is never read as missing data. */}
            <HStack
              gap={3}
              paddingInline={4}
              paddingBlock={3}
              justify="between"
              align="center"
              wrap="wrap"
            >
              <HStack gap={3} align="center" wrap="wrap">
                <Heading level={2}>Lịch sử yêu cầu</Heading>
                {/* Only once the list is real: "0 yêu cầu" while loading reads
                    as an answer, and an admin would act on it. */}
                {requests.data ? (
                  <Text type="supporting" role="status" aria-live="polite">
                    {items.length} yêu cầu · {ACCESS_FILTER_LABELS[status].toLowerCase()}
                  </Text>
                ) : null}
              </HStack>

              <SegmentedControl
                label="Lọc theo trạng thái yêu cầu"
                value={status}
                onChange={selectStatus}
                size="sm"
              >
                {ACCESS_FILTER_STATUSES.map((value) => (
                  <SegmentedControlItem
                    key={value}
                    value={value}
                    label={ACCESS_FILTER_LABELS[value]}
                  />
                ))}
              </SegmentedControl>
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
        </LayoutContent>
      }
    />
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
        <Stack direction="vertical" padding={6}>
          <EmptyState
            headingLevel={3}
            title="Không còn ai chờ duyệt"
            description="Luồng chờ duyệt đã nghỉ hưu nên sẽ không có yêu cầu mới nào xuất hiện ở đây. Muốn thêm người, hãy tạo link mời ở màn Thành viên."
            actions={
              <Button variant="secondary" label="Xem tất cả lịch sử" onClick={onShowAll} />
            }
          />
        </Stack>
      );
    }

    if (status === "all") {
      return (
        <Stack direction="vertical" padding={6}>
          <EmptyState
            headingLevel={3}
            title="Chưa có yêu cầu nào trong lịch sử"
            description="Không tài khoản nào từng đi qua luồng chờ duyệt của đơn vị này. Thành viên hiện tại được thêm bằng link mời — xem ở màn Thành viên."
          />
        </Stack>
      );
    }

    // Filtered out, not lost: the data may well exist under another filter.
    return (
      <Stack direction="vertical" padding={6}>
        <EmptyState
          headingLevel={3}
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
