import { ChannelProgress } from "@/ui/components/batch/ChannelProgress";
import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import {
  facebookPostUrl,
  formatDateTime,
  type BatchChannelStatus,
} from "@/ui/schemas/post-batch.schema";

/**
 * Per-channel result table of one batch (E7.5, brief §6).
 *
 * Business rule 6 made visible: every channel is its own row with its own
 * status and its own reason — one Page failing says nothing about the others.
 * `userMessage` comes from the server already in Vietnamese; the UI never
 * invents a reason, and never hides one.
 *
 * Presentational only: no fetching, no retry logic (that lives on /jobs).
 *
 * A row that is still moving also carries its live progress block (design
 * §5.9). `progressSteps` comes down with the payload rather than being imported:
 * `ui/` may not reach into `core/` (docs/07 §2), and a second copy of the labels
 * would be the thing that drifts the day a stage is added.
 */
export function BatchChannelTable({
  channels,
  progressSteps,
}: {
  channels: readonly BatchChannelStatus[];
  progressSteps: readonly string[];
}) {
  return (
    <section aria-labelledby="batch-channels-heading" className="space-y-3">
      <h2 id="batch-channels-heading" className="text-base font-semibold">
        Kết quả theo từng kênh
      </h2>

      {/* tabindex + label: the horizontal scroller must be reachable by keyboard. */}
      <div
        className="overflow-x-auto rounded-xl border"
        tabIndex={0}
        role="region"
        aria-label="Bảng kết quả theo kênh, cuộn ngang được"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Trạng thái đăng bài của từng kênh trong lô, kèm số lần thử và lý do lỗi
          </caption>
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[54%]" />
          </colgroup>
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th scope="col" className="px-3 py-2 font-medium">
                Kênh
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Trạng thái
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Số lần thử
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Kết quả
              </th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => {
              const link =
                channel.publishedUrl ??
                (channel.publishedPostId ? facebookPostUrl(channel.publishedPostId) : null);

              return (
                <tr key={channel.postJobId} className="border-t align-top">
                  <th scope="row" className="px-3 py-2 text-left font-medium break-all">
                    {channel.channelId}
                  </th>
                  <td className="px-3 py-2">
                    <JobStatusBadge status={channel.status} />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{channel.attemptCount}</td>
                  <td className="px-3 py-2">
                    <p className={channel.status === "published" ? "" : "text-muted-foreground"}>
                      {channel.userMessage}
                    </p>
                    {link ? (
                      <p className="mt-1">
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-primary underline underline-offset-4"
                        >
                          Mở bài đã đăng trên Facebook
                        </a>
                        <span className="sr-only"> (mở tab mới)</span>
                      </p>
                    ) : null}
                    {channel.publishedAt ? (
                      <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                        Đăng lúc {formatDateTime(channel.publishedAt)}
                      </p>
                    ) : null}
                    {channel.lastErrorCode ? (
                      <p className="text-muted-foreground/80 mt-1 font-mono text-xs">
                        Mã lỗi: {channel.lastErrorCode}
                      </p>
                    ) : null}
                    {/* Present only while the job is queued/publishing — the
                        server drops it for every other status (law 3.1), so
                        this row never has to decide. */}
                    {channel.progress ? (
                      <ChannelProgress
                        progress={channel.progress}
                        steps={progressSteps}
                        channelId={channel.channelId}
                        statusMessage={channel.userMessage}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
