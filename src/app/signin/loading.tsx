import { Card, Grid, Section, Skeleton, Stack, Text } from "@astryxdesign/core";

/**
 * Route-level loading state for `/signin`.
 *
 * The page is `force-dynamic`, so on a cold hit the operator waits on a server
 * render before anything paints. Without this file that wait is a blank body;
 * with it, the split frame is already on screen and only the words are missing.
 *
 * The shape is copied from `SignInScreen`, not invented: same 50/50 grid, same
 * muted left half, same 420px cap on the right, same block order (heading,
 * tab strip, muted credentials card, provider pair). Matching the real layout
 * is the whole point — a placeholder of the wrong size just moves the jump
 * from "blank to content" to "wrong shape to content" (web-feedback-states §1).
 *
 * Every bar is inside an `aria-hidden` region: a screen reader gets the one
 * polite sentence instead of a dozen nameless boxes.
 */
export default function SignInLoading() {
  return (
    <main className="flex w-full flex-1">
      <Grid
        columns={{ minWidth: 460, max: 2, repeat: "fit" }}
        gap={0}
        width="100%"
        className="flex-1"
      >
        <Section variant="muted" padding={8}>
          <Stack
            direction="vertical"
            gap={6}
            height="100%"
            vAlign="center"
            maxWidth={480}
            className="mx-auto"
            aria-hidden="true"
          >
            {/* Brand lockup */}
            <Skeleton width={180} height={20} />

            {/* Headline + one supporting line */}
            <Stack direction="vertical" gap={2}>
              <Skeleton width="80%" height={40} index={1} />
              <Skeleton width="60%" height={16} index={2} />
            </Stack>

            {/* The five value lines */}
            <Stack direction="vertical" gap={3}>
              {[0, 1, 2, 3, 4].map((line) => (
                <Skeleton key={line} width="100%" height={16} index={line + 3} />
              ))}
            </Stack>
          </Stack>
        </Section>

        <Section variant="transparent" padding={6}>
          <Stack direction="vertical" vAlign="center" height="100%">
            <Stack
              direction="vertical"
              gap={5}
              width="100%"
              maxWidth={420}
              className="mx-auto"
              as="section"
              aria-label="Đang mở trang đăng nhập"
            >
              <Text type="supporting" role="status" aria-live="polite">
                Đang mở trang đăng nhập, vui lòng đợi.
              </Text>

              <Stack direction="vertical" gap={5} aria-hidden="true">
                {/* Heading */}
                <Skeleton width="70%" height={28} />

                {/* Tab strip */}
                <Skeleton width="100%" height={36} index={1} />

                {/* The muted credentials card, drawn at its real height so the
                    provider buttons below do not jump when the page arrives. */}
                <Card variant="muted" padding={4}>
                  <Stack direction="vertical" gap={3}>
                    <Skeleton width="55%" height={20} index={2} />
                    <Skeleton width="100%" height={32} index={3} />
                    <Skeleton width="100%" height={60} index={4} />
                    <Skeleton width="100%" height={60} index={5} />
                    <Skeleton width="100%" height={44} index={6} />
                  </Stack>
                </Card>

                {/* The provider pair */}
                <Grid columns={{ minWidth: 170, max: 2, repeat: "fit" }} gap={3}>
                  <Skeleton width="100%" height={44} index={7} />
                  <Skeleton width="100%" height={44} index={8} />
                </Grid>
              </Stack>
            </Stack>
          </Stack>
        </Section>
      </Grid>
    </main>
  );
}
