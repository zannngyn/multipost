"use client";

import { Tab, TabList } from "@astryxdesign/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { JobLogScreen } from "@/ui/components/jobs/JobLogScreen";
import {
  POSTS_TABS,
  POSTS_TAB_LABELS,
  parsePostsTab,
  type PostsTab,
} from "@/ui/components/posts/posts-tabs";
import { ScheduledScreen } from "@/ui/components/scheduled/ScheduledScreen";

/**
 * "Bài đăng" — the wave-1 hub over the two screens that answer the same
 * question at two points in time: what is about to go out ("Bài đã hẹn") and
 * what already ran ("Nhật ký đăng"). `/scheduled` and `/jobs` redirect here.
 *
 * The hub owns NO data. Both child screens keep their own query, their own
 * filter in the URL and their own loading / data / empty / error states — this
 * file only decides which of the two is on screen, so there is no second source
 * of truth for either screen's state.
 *
 * `TabList`, not `SegmentedControl`: Astryx draws the line at navigation vs
 * input, and these two tabs used to be two routes — they still are two
 * addresses (`?tab=`), and TabList marks the current one with `aria-current`
 * inside a labelled <nav>. `SegmentedControl` is already used INSIDE the
 * scheduled screen for its list/calendar mode; reusing it here would put two
 * identical-looking controls one above the other meaning different things.
 *
 * Tabs are buttons, not links: Astryx's `Tab href` fires `onChange` on top of
 * the anchor's own navigation, so a link tab would navigate twice.
 */
export function PostsHub({ tab }: { tab: PostsTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The URL wins once the client is live (Back/Forward and the redirect from
  // `/jobs` both land here); `tab` is what the server already parsed, used
  // until the browser has search params of its own.
  const active = searchParams.has("tab") ? parsePostsTab(searchParams.get("tab")) : tab;

  const handleChange = useCallback(
    (value: string) => {
      const next = parsePostsTab(value);
      if (next === active) return;
      // Only `?tab=` survives the switch. The rest of the query belongs to the
      // screen being left — `?status=failed` is a job-log filter and would be
      // dead weight (or worse, a misread) on the scheduled list.
      //
      // replace(), not push(): this is one page seen two ways, and pushing
      // would make Back walk the operator through every tab click before it
      // leaves the screen (core-routing-patterns §"Điều hướng").
      router.replace(`/posts?tab=${next}`, { scroll: false });
    },
    [active, router],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Bài đăng</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Bài đang chờ tới giờ đăng và nhật ký những bài đã chạy — theo dõi ở cùng một chỗ.
        </p>
      </header>

      {/* The shell's side nav is the other <nav> on the page, so this one says
          what it navigates (core-accessibility §2). */}
      <TabList value={active} onChange={handleChange} aria-label="Chế độ xem bài đăng" hasDivider>
        {POSTS_TABS.map((value) => (
          <Tab key={value} value={value} label={POSTS_TAB_LABELS[value]} />
        ))}
      </TabList>

      {active === "scheduled" ? <ScheduledScreen /> : <JobLogScreen />}
    </div>
  );
}
