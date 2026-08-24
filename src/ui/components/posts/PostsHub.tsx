"use client";

import {
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Tab,
  TabList,
  Text,
} from "@astryxdesign/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { JobLogScreen } from "@/ui/components/jobs/JobLogScreen";
import {
  POSTS_TABS,
  POSTS_TAB_LABELS,
  POSTS_TAB_PARAM,
  parsePostsTab,
  resolveActiveTab,
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
  // until the browser has search params of its own. The rule itself lives in
  // `resolveActiveTab` so it can be tested without rendering.
  const active = resolveActiveTab(searchParams.get(POSTS_TAB_PARAM), tab);

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
      router.replace(`/posts?${POSTS_TAB_PARAM}=${next}`, { scroll: false });
    },
    [active, router],
  );

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          {/* The SAME column as the content below — `max-w-5xl` centred, `px-6`
              — so the h1 sits on the left edge of the panel it titles, while
              the divider still runs the full width of the shell because it
              belongs to LayoutHeader rather than to this box. The frame the
              other two hubs already use (`ChannelsHub`, `MembersHub`); this
              screen was the last one still hand-rolling a page container. */}
          <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-4">
            <div className="max-w-prose space-y-1">
              <Heading level={1}>Bài đăng</Heading>
              <Text type="supporting">
                Bài đang chờ tới giờ đăng và nhật ký những bài đã chạy — theo dõi ở cùng một chỗ.
              </Text>
            </div>

            {/* The shell's side nav is the other <nav> on the page, so this one
                says what it navigates (core-accessibility §2). */}
            <TabList value={active} onChange={handleChange} aria-label="Chế độ xem bài đăng">
              {POSTS_TABS.map((value) => (
                <Tab key={value} value={value} label={POSTS_TAB_LABELS[value]} />
              ))}
            </TabList>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          {/* `relative`, and it is load-bearing — the same trap AppFrame
              documents, one level down, and the one `BulkRunScreen` was patched
              for. `sr-only` is `position: absolute`, so every visually hidden
              node below (the job-log table captions, the scheduled list's
              headings) anchors to the nearest POSITIONED ancestor. Astryx's
              layout content is `static`, so they escape this scroll box and
              land on the shell wrapper above it — which stretches
              `documentElement.scrollHeight` past the viewport and hands the
              page a SECOND scrollbar with nothing but background in it. */}
          <div className="relative mx-auto w-full max-w-5xl px-6 py-8">
            {active === "scheduled" ? <ScheduledScreen /> : <JobLogScreen />}
          </div>
        </LayoutContent>
      }
    />
  );
}
