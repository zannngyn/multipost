"use client";

import {
  Calendar,
  Check,
  HelpCircle,
  ImageIcon,
  Info,
  Link2,
  MessageSquare,
  PenLine,
  Plus,
  Shield,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { cn } from "@/shared/utils";
import { Button } from "@/ui/components/ui/button";
import { useChannels } from "@/ui/hooks/useChannels";
import { useMe } from "@/ui/hooks/useMe";
import { usePostJobLog } from "@/ui/hooks/usePostJobs";
import { useScheduledJobs } from "@/ui/hooks/useScheduledJobs";
import { accountDisplayName } from "@/ui/schemas/me.schema";
import type { JobLogFilter } from "@/ui/schemas/post-batch.schema";
import type { ScheduledFilter } from "@/ui/schemas/scheduled.schema";

const ALL_SCHEDULED: ScheduledFilter = { channelId: null, from: null, to: null };
const ALL_JOBS: JobLogFilter = { status: null, batchId: null };

export function OverviewScreen() {
  const me = useMe();
  const channels = useChannels();
  const scheduled = useScheduledJobs(ALL_SCHEDULED);
  const jobs = usePostJobLog(ALL_JOBS);

  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackGoal, setFeedbackGoal] = useState("");
  const [feedbackObstacle, setFeedbackObstacle] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);

  const displayName = accountDisplayName(me.data, "bạn");

  const greetingText = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Chào buổi sáng";
    if (hour < 18) return "Chào buổi chiều";
    return "Chào buổi tối";
  }, []);

  const formattedDate = useMemo(() => {
    const now = new Date();
    return now.toLocaleDateString("vi-VN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }, []);

  const connectedChannelsCount = channels.data?.channels.length ?? 0;
  const isChannelConnected = connectedChannelsCount > 0;

  const scheduledCount = scheduled.data?.pages[0]?.items.length ?? 0;
  const hasScheduledPosts = scheduledCount > 0;

  const totalJobsCount = jobs.data?.pages[0]?.items.length ?? 0;
  const hasCreatedPosts = totalJobsCount > 0;

  const handleSubmitFeedback = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackGoal.trim() || !feedbackObstacle.trim()) return;
    setIsSubmitted(true);
    setTimeout(() => {
      setIsSubmitted(false);
      setIsFeedbackOpen(false);
      setFeedbackGoal("");
      setFeedbackObstacle("");
    }, 1500);
  };

  return (
    <div className="w-full space-y-6 px-6 py-6 sm:px-8 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 items-center justify-center rounded-xl bg-amber-100/70 text-2xl shadow-xs">
            👋
          </span>
          <div>
            <h1 className="text-foreground text-xl font-bold tracking-tight sm:text-2xl">
              {greetingText}, {displayName}!
            </h1>
            <p className="text-muted-foreground text-xs font-medium capitalize">{formattedDate}</p>
          </div>
        </div>

        <button
          type="button"
          aria-label="Gửi phản hồi"
          onClick={() => setIsFeedbackOpen(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-full p-2 text-xs font-medium transition-colors"
        >
          <Shield className="size-4.5" />
        </button>
      </div>

      <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-xs">
        <div className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0 divide-border/60 py-5">
          <div className="flex items-center justify-center gap-3 px-6 py-1">
            <span className="bg-secondary text-foreground flex size-9 items-center justify-center rounded-full font-mono text-sm font-semibold">
              0
            </span>
            <span className="text-foreground text-sm font-semibold">Chuỗi tuần</span>
            <Info className="text-muted-foreground/60 size-3.5 cursor-help" />
          </div>

          <div className="flex items-center justify-center gap-3 px-6 py-1">
            <span className="bg-secondary text-foreground flex size-9 items-center justify-center rounded-full font-mono text-sm font-semibold">
              0
            </span>
            <span className="text-foreground text-sm font-semibold">Mục tiêu đăng</span>
            <Info className="text-muted-foreground/60 size-3.5 cursor-help" />
          </div>

          <div className="flex items-center justify-center gap-3 px-6 py-1">
            <span className="bg-secondary text-foreground flex size-9 items-center justify-center rounded-full font-mono text-sm font-semibold">
              0
            </span>
            <span className="text-foreground text-sm font-semibold">Điểm tương tác</span>
            <Info className="text-muted-foreground/60 size-3.5 cursor-help" />
          </div>
        </div>

        <div className="border-border/60 bg-primary/5 text-foreground flex items-center gap-2 border-t px-6 py-3 text-xs font-medium">
          <Link2 className="text-primary size-4 shrink-0" />
          <p>
            <Link
              href="/channels"
              className="text-primary hover:underline font-semibold"
            >
              Kết nối kênh
            </Link>{" "}
            để bắt đầu theo dõi chuỗi đăng bài, thiết lập mục tiêu và nhiều tính năng khác.
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-foreground text-xs font-bold uppercase tracking-wider">
          Các bước đầu tiên
        </h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="border-border bg-card flex flex-col justify-between rounded-xl border p-4.5 shadow-xs transition-shadow hover:shadow-sm">
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-foreground text-sm font-bold">1. Kết nối kênh</h3>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full",
                    isChannelConnected
                      ? "bg-emerald-500 text-white"
                      : "text-muted-foreground/40 border border-current",
                  )}
                >
                  {isChannelConnected ? <Check className="size-3.5 stroke-[3]" /> : null}
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Kết nối các trang Facebook và TikTok để bắt đầu đăng bài tự động.
              </p>
            </div>

            <div className="pt-4">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="text-foreground border-border hover:bg-muted h-8 w-fit gap-1.5 rounded-lg px-3 text-xs font-semibold"
              >
                <Link href="/channels">
                  <Plus className="size-3.5" />
                  Kết nối kênh
                </Link>
              </Button>
            </div>
          </div>

          <div className="border-border bg-card flex flex-col justify-between rounded-xl border p-4.5 shadow-xs transition-shadow hover:shadow-sm">
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-foreground text-sm font-bold">2. Soạn bài viết</h3>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full",
                    hasCreatedPosts || hasScheduledPosts
                      ? "bg-emerald-500 text-white"
                      : "text-muted-foreground/40 border border-current",
                  )}
                >
                  {hasCreatedPosts || hasScheduledPosts ? (
                    <Check className="size-3.5 stroke-[3]" />
                  ) : null}
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Lên lịch bài viết đầu tiên của bạn chỉ với vài thao tác.
              </p>
            </div>

            <div className="pt-4">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="text-foreground border-border hover:bg-muted h-8 w-fit gap-1.5 rounded-lg px-3 text-xs font-semibold"
              >
                <Link href="/compose">
                  <PenLine className="size-3.5" />
                  Soạn bài viết
                </Link>
              </Button>
            </div>
          </div>

          <div className="border-border bg-card flex flex-col justify-between rounded-xl border p-4.5 shadow-xs transition-shadow hover:shadow-sm">
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-foreground text-sm font-bold">3. Làm việc nhóm?</h3>
                <span className="text-muted-foreground/40 flex size-5 shrink-0 items-center justify-center rounded-full border border-current"></span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Mời đội ngũ cùng tham gia quản lý và phân quyền đăng bài.
              </p>
            </div>

            <div className="pt-4">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="text-foreground border-border hover:bg-muted h-8 w-fit gap-1.5 rounded-lg px-3 text-xs font-semibold"
              >
                <Link href="/settings/members">
                  <UserPlus className="size-3.5" />
                  Mời thành viên
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-foreground text-sm font-bold">Sắp đăng</h2>
            {hasScheduledPosts ? (
              <Link
                href="/posts?tab=scheduled"
                className="text-primary hover:underline text-xs font-semibold"
              >
                Xem tất cả ({scheduledCount})
              </Link>
            ) : null}
          </div>

          <div className="border-border bg-card flex min-h-[190px] flex-col items-center justify-center rounded-2xl border p-6 text-center shadow-xs">
            <span className="bg-secondary text-muted-foreground flex size-11 items-center justify-center rounded-xl">
              <Calendar className="size-5.5" />
            </span>
            <h3 className="text-foreground mt-3 text-sm font-bold">
              {hasScheduledPosts
                ? `${scheduledCount} bài viết đã được lên lịch`
                : "Chưa có bài viết nào được lên lịch."}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {hasScheduledPosts
                ? "Bài viết sẽ tự động xuất bản theo đúng lịch hẹn."
                : "Các bài viết chờ xuất bản sẽ xuất hiện tại đây."}
            </p>
          </div>
        </section>

        <section className="space-y-2.5">
          <h2 className="text-foreground text-sm font-bold">Bình luận</h2>

          <div className="border-border bg-card flex min-h-[190px] flex-col items-center justify-center rounded-2xl border p-6 text-center shadow-xs">
            <span className="bg-secondary text-muted-foreground flex size-11 items-center justify-center rounded-xl">
              <MessageSquare className="size-5.5" />
            </span>
            <h3 className="text-foreground mt-3 text-sm font-bold">Chưa có bình luận nào.</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Các phản hồi và bình luận mới nhất sẽ hiển thị tại đây.
            </p>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="text-foreground text-sm font-bold">Mẫu bài viết gợi ý</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            href="/compose"
            className="border-border bg-card hover:border-primary/50 group flex flex-col justify-between rounded-xl border p-4 shadow-xs transition-all hover:shadow-sm"
          >
            <div className="space-y-2">
              <span className="text-xl">🧩</span>
              <h3 className="text-foreground group-hover:text-primary text-sm font-bold transition-colors">
                Phân tích từng bước chi tiết
              </h3>
              <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                Chia nhỏ một chủ đề hoặc tính năng sản phẩm thành các bước rõ ràng, dễ theo dõi.
              </p>
            </div>
          </Link>

          <Link
            href="/compose"
            className="border-border bg-card hover:border-primary/50 group flex flex-col justify-between rounded-xl border p-4 shadow-xs transition-all hover:shadow-sm"
          >
            <div className="space-y-2">
              <span className="text-xl">🛠️</span>
              <h3 className="text-foreground group-hover:text-primary text-sm font-bold transition-colors">
                Đánh giá chân thực về sản phẩm
              </h3>
              <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                Chia sẻ trải nghiệm thực tế về sản phẩm/công cụ — ưu điểm, nhược điểm và đối tượng phù hợp...
              </p>
            </div>
          </Link>

          <Link
            href="/compose"
            className="border-border bg-card hover:border-primary/50 group flex flex-col justify-between rounded-xl border p-4 shadow-xs transition-all hover:shadow-sm"
          >
            <div className="space-y-2">
              <span className="text-xl">⏱️</span>
              <h3 className="text-foreground group-hover:text-primary text-sm font-bold transition-colors">
                Hệ thống tiết kiệm thời gian
              </h3>
              <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                Chia sẻ quy trình tự động hóa giúp bạn tối ưu thời gian và vận hành bán hàng mượt mà hơn...
              </p>
            </div>
          </Link>

          <Link
            href="/compose"
            className="border-border bg-card hover:border-primary/50 group flex flex-col justify-between rounded-xl border p-4 shadow-xs transition-all hover:shadow-sm"
          >
            <div className="space-y-2">
              <span className="text-xl">🎃</span>
              <h3 className="text-foreground group-hover:text-primary text-sm font-bold transition-colors">
                3 mẹo giữ chân khách hàng
              </h3>
              <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                Mẹo nhanh và thực tế giúp bạn duy trì tương tác và chăm sóc khách hàng mùa cao điểm.
              </p>
            </div>
          </Link>
        </div>
      </section>

      <aside aria-label="Trợ giúp" className="fixed right-6 bottom-6 z-30">
        <a
          href="/support"
          className="bg-primary text-primary-foreground hover:bg-primary/90 flex size-10 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105"
        >
          <HelpCircle className="size-5.5" />
          <span className="sr-only">Trợ giúp</span>
        </a>
      </aside>

      {isFeedbackOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-end p-4 sm:p-6">
          <div
            className="fixed inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity"
            onClick={() => setIsFeedbackOpen(false)}
          />

          <div className="border-border bg-card relative z-10 w-full max-w-md overflow-hidden rounded-2xl border p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150 font-sans">
            {isSubmitted ? (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                <span className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <Check className="size-6 stroke-[3]" />
                </span>
                <h3 className="text-foreground text-base font-bold">Cảm ơn bạn đã đóng góp ý kiến!</h3>
                <p className="text-muted-foreground text-xs">
                  Phản hồi của bạn đã được ghi nhận để cải thiện MYSP.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitFeedback} className="space-y-4">
                <div className="space-y-1.5">
                  <h3 className="text-foreground text-base font-bold leading-snug">
                    Điều gì có thể giúp MYSP phục vụ bạn tốt hơn?
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    Gặp sự cố hoặc cần hỗ trợ?{" "}
                    <Link
                      href="/support"
                      className="border-emerald-600/40 bg-emerald-50 text-emerald-700 hover:bg-emerald-100/70 inline-block rounded-md border px-2 py-0.5 font-medium transition-colors"
                    >
                      Liên hệ hỗ trợ
                    </Link>
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="feedback-goal" className="text-foreground font-semibold">
                      Bạn đang cố gắng thực hiện điều gì?
                    </label>
                    <span className="text-muted-foreground">Bắt buộc</span>
                  </div>
                  <textarea
                    id="feedback-goal"
                    required
                    maxLength={300}
                    rows={3}
                    value={feedbackGoal}
                    onChange={(e) => setFeedbackGoal(e.target.value)}
                    className="border-input bg-background text-foreground focus-visible:ring-ring w-full resize-none rounded-xl border p-3 text-xs outline-none focus-visible:ring-2"
                  />
                  <div className="text-muted-foreground text-right text-[11px]">
                    {feedbackGoal.length}/300
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="feedback-obstacle" className="text-foreground font-semibold">
                      Khó khăn bạn gặp phải là gì, và điều gì có thể giúp ích?
                    </label>
                    <span className="text-muted-foreground">Bắt buộc</span>
                  </div>
                  <textarea
                    id="feedback-obstacle"
                    required
                    maxLength={300}
                    rows={3}
                    value={feedbackObstacle}
                    onChange={(e) => setFeedbackObstacle(e.target.value)}
                    className="border-input bg-background text-foreground focus-visible:ring-ring w-full resize-none rounded-xl border p-3 text-xs outline-none focus-visible:ring-2"
                  />
                  <div className="text-muted-foreground text-right text-[11px]">
                    {feedbackObstacle.length}/300
                  </div>
                </div>

                <div className="border-border text-muted-foreground hover:border-foreground/30 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-xs transition-colors">
                  <ImageIcon className="size-4" />
                  <span>
                    Kéo thả hoặc{" "}
                    <span className="text-emerald-700 underline underline-offset-2 font-medium">
                      tải tệp lên
                    </span>
                  </span>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsFeedbackOpen(false)}
                    className="text-foreground hover:bg-muted rounded-lg px-4 py-2 text-xs font-semibold transition-colors"
                  >
                    Đóng
                  </button>
                  <button
                    type="submit"
                    disabled={!feedbackGoal.trim() || !feedbackObstacle.trim()}
                    className="bg-[#9ae68e] text-emerald-950 hover:bg-[#88de7b] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-5 py-2 text-xs font-bold transition-all shadow-xs"
                  >
                    Gửi phản hồi
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
