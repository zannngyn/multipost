"use client";

import { useId, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";

import {
  countChannelStatuses,
  filterBatchChannels,
  showsStatusPill,
  type ChannelStatusFilter,
} from "@/ui/components/batch/batch-channel-filter";
import { ChannelProgress } from "@/ui/components/batch/ChannelProgress";
import {
  channelLabelIndex,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { ChannelNameCell } from "@/ui/components/channels/ChannelNameCell";
import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import type { Channel } from "@/ui/schemas/channel.schema";
import {
  facebookPostUrl,
  formatDateTime,
  type BatchChannelStatus,
} from "@/ui/schemas/post-batch.schema";

export function BatchChannelTable({
  channels,
  progressSteps,
  tenantChannels,
}: {
  channels: readonly BatchChannelStatus[];
  progressSteps: readonly string[];
  tenantChannels?: readonly Channel[];
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ChannelStatusFilter>("all");

  // Memoised, because this Map is a dependency of the filter below: rebuilding
  // it every render made that `useMemo` recompute every render too.
  const labels = useMemo(
    () => channelLabelIndex(channels.map((channel) => channel.channelId), tenantChannels),
    [channels, tenantChannels],
  );

  const filteredChannels = useMemo(
    () => filterBatchChannels(channels, statusFilter, search, labels),
    [channels, statusFilter, search, labels],
  );

  const counts = useMemo(() => countChannelStatuses(channels), [channels]);

  return (
    <section aria-labelledby="batch-channels-heading" className="flex flex-col gap-4">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 id="batch-channels-heading" className="text-base font-semibold text-foreground">
            Kết quả theo từng kênh
          </h2>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({filteredChannels.length}/{channels.length} kênh)
          </span>
        </div>

        {/* Filter Pills + Search */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter Buttons */}
          <div className="flex items-center gap-1 rounded-lg border border-border/80 bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => setStatusFilter("all")}
              className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                statusFilter === "all"
                  ? "bg-card text-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Tất cả ({counts.all})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("published")}
              className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                statusFilter === "published"
                  ? "bg-card text-leaf-deep font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Đã đăng ({counts.published})
            </button>
            {/* Kept while it is the ACTIVE filter even at zero: this screen polls,
                so a retry that succeeds would otherwise remove the very pill that
                is filtering, leaving an empty table and no way back. */}
            {showsStatusPill(counts.active, "active", statusFilter) && (
              <button
                type="button"
                onClick={() => setStatusFilter("active")}
                className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  statusFilter === "active"
                    ? "bg-card text-primary font-semibold shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Đang chạy ({counts.active})
              </button>
            )}
            {showsStatusPill(counts.issues, "issues", statusFilter) && (
              <button
                type="button"
                onClick={() => setStatusFilter("issues")}
                className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  statusFilter === "issues"
                    ? "bg-card text-madder font-semibold shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Lỗi/Chặn ({counts.issues})
              </button>
            )}
          </div>

          {/* Search Box */}
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Tìm trong danh sách kênh của lô này
            </label>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              id={searchId}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm tên kênh hoặc mã..."
              className="h-8 w-44 rounded-lg border border-border/80 bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary md:w-56"
            />
          </div>
        </div>
      </div>

      {/* Table Container */}
      <div
        className="overflow-x-auto rounded-xl border border-border/80 bg-card shadow-xs"
        tabIndex={0}
        role="region"
        aria-label="Bảng kết quả theo kênh"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Trạng thái đăng bài của từng kênh trong lô, kèm số lần thử và lý do lỗi
          </caption>
          <thead className="border-b border-border/80 bg-muted/40 text-xs text-muted-foreground">
            <tr className="text-left">
              <th scope="col" className="px-4 py-3 font-semibold">
                Kênh Facebook
              </th>
              <th scope="col" className="px-4 py-3 font-semibold w-32">
                Trạng thái
              </th>
              <th scope="col" className="px-4 py-3 font-semibold w-24 text-center">
                Số lần thử
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Kết quả chi tiết
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filteredChannels.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-xs text-muted-foreground">
                  Không tìm thấy kênh nào khớp với bộ lọc hiện tại.
                </td>
              </tr>
            ) : (
              filteredChannels.map((channel) => {
                const link =
                  channel.publishedUrl ??
                  (channel.publishedPostId ? facebookPostUrl(channel.publishedPostId) : null);

                return (
                  <tr
                    key={channel.postJobId}
                    className="align-top transition-colors hover:bg-accent/20"
                  >
                    {/* Channel info — the row's header, so a screen reader can
                        name which channel a status cell belongs to. */}
                    <th scope="row" className="px-4 py-3.5 text-left">
                      <div className="font-medium text-foreground">
                        <ChannelNameCell
                          channelId={channel.channelId}
                          label={labels.get(channel.channelId)}
                        />
                      </div>
                    </th>

                    {/* Status Badge */}
                    <td className="px-4 py-3.5">
                      <JobStatusBadge status={channel.status} />
                    </td>

                    {/* Attempt Count */}
                    <td className="px-4 py-3.5 text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {channel.attemptCount}
                    </td>

                    {/* Result & Actions */}
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col gap-1.5">
                        <p
                          className={`text-xs leading-relaxed ${
                            channel.status === "published"
                              ? "font-medium text-foreground"
                              : channel.status === "failed" || channel.status === "blocked"
                                ? "text-madder"
                                : "text-muted-foreground"
                          }`}
                        >
                          {channel.userMessage}
                        </p>

                        {/* Direct Facebook Post Link */}
                        {link && (
                          <div className="pt-0.5">
                            <a
                              href={link}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                            >
                              <span>Mở bài viết trên Facebook</span>
                              <ExternalLink className="size-3" />
                            </a>
                          </div>
                        )}

                        {channel.publishedAt && (
                          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                            Đã đăng: {formatDateTime(channel.publishedAt)}
                          </span>
                        )}

                        {channel.lastErrorCode && (
                          <span className="font-mono text-[11px] text-muted-foreground/80">
                            Mã lỗi: {channel.lastErrorCode}
                          </span>
                        )}

                        {/* Live progress when running */}
                        {channel.progress && (
                          <div className="pt-1">
                            <ChannelProgress
                              progress={channel.progress}
                              steps={progressSteps}
                              channelLabel={channelSentenceName(channel.channelId, labels)}
                              statusMessage={channel.userMessage}
                            />
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
