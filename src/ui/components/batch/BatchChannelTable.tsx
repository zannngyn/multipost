"use client";

import { useState, useMemo } from "react";
import { ExternalLink, Search } from "lucide-react";

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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "active" | "issues">("all");

  const labels = channelLabelIndex(
    channels.map((channel) => channel.channelId),
    tenantChannels,
  );

  // Filter logic
  const filteredChannels = useMemo(() => {
    return channels.filter((channel) => {
      // 1. Status filter
      if (statusFilter === "published" && channel.status !== "published") return false;
      if (
        statusFilter === "active" &&
        channel.status !== "queued" &&
        channel.status !== "publishing"
      )
        return false;
      if (
        statusFilter === "issues" &&
        channel.status !== "failed" &&
        channel.status !== "blocked"
      )
        return false;

      // 2. Search filter
      if (search.trim().length > 0) {
        const query = search.toLowerCase();
        const label = labels.get(channel.channelId);
        const name = label?.name?.toLowerCase() ?? "";
        const id = channel.channelId.toLowerCase();
        const msg = channel.userMessage.toLowerCase();
        return name.includes(query) || id.includes(query) || msg.includes(query);
      }

      return true;
    });
  }, [channels, statusFilter, search, labels]);

  // Counts for filter pills
  const counts = useMemo(() => {
    let published = 0;
    let active = 0;
    let issues = 0;
    for (const c of channels) {
      if (c.status === "published") published++;
      else if (c.status === "queued" || c.status === "publishing") active++;
      else if (c.status === "failed" || c.status === "blocked") issues++;
    }
    return { all: channels.length, published, active, issues };
  }, [channels]);

  return (
    <div className="flex flex-col gap-4">
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
            {counts.active > 0 && (
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
            {counts.issues > 0 && (
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
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
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
                    {/* Channel info */}
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-foreground">
                        <ChannelNameCell
                          channelId={channel.channelId}
                          label={labels.get(channel.channelId)}
                        />
                      </div>
                    </td>

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
    </div>
  );
}
