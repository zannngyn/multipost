import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FOCUS_CHANNELS } from "@/ui/schemas/onboarding-profile.schema";

import { ChannelTileGroup } from "../ChannelTile";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom.
 *
 * The tiles are checkboxes, not radios. Spec section 7.5 lists step 4 among the
 * single-choice steps, but the field it writes is `focusChannels: string[]`
 * (task 1's port), the reference shot `04-channels.jpg` draws a CHECKBOX in the
 * tile's corner, and spec section 6 calls the coming-soon tiles "phiếu bầu nhu
 * cầu" — three votes for many, one for one. Flagged for the PM rather than
 * silently resolved.
 */

const noop = () => {};

const CHOICES = [
  { value: "facebook" as const },
  { value: "tiktok" as const, isComingSoon: true },
  { value: "shopee" as const, isComingSoon: true },
];

describe("ChannelTileGroup — dạng D", () => {
  it("says 'sắp có' in WORDS, never in opacity alone", () => {
    // Spec section 6: a tile that is dimmed but still pressable is a state that
    // lies. The words are what stop the promise being read as shipped.
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );

    expect(html.match(/Sắp có/g)).toHaveLength(2);
    expect(html).toContain("TikTok");
    expect(html).toContain("Shopee");
  });

  it("leaves Facebook — the one channel that works — unlabelled", () => {
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={[{ value: "facebook" as const }]}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(html).toContain("Facebook");
    expect(html).not.toContain("Sắp có");
  });

  it("still lets a coming-soon channel be chosen", () => {
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={["tiktok"]}
        onToggle={noop}
      />,
    );
    // Not `disabled`: the answer is a demand signal, so it has to be givable.
    expect(html).not.toContain("disabled");
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("is a group of real checkboxes with the hit area on the whole tile", () => {
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );

    expect(html.match(/type="checkbox"/g)).toHaveLength(CHOICES.length);
    expect(html).toContain("<label");
    expect(html).toContain("<fieldset");
    expect(html).not.toContain('role="checkbox"');
  });

  it("shows the tick box at all times, not only under a mouse", () => {
    // Spec section 5.4: Buffer reveals it on hover. A state that only exists
    // under a pointer does not exist for a keyboard or for a finger.
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(html.match(/data-slot="channel-tick-box"/g)).toHaveLength(CHOICES.length);
    expect(html).not.toContain("group-hover");
  });

  it("fills the tick box only for the channels that were chosen", () => {
    const chosen = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={["facebook"]}
        onToggle={noop}
      />,
    );
    const none = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );

    expect(chosen.match(/data-slot="option-tick"/g)).toHaveLength(1);
    expect(none).not.toContain('data-slot="option-tick"');
  });

  it("keeps the measured tile size", () => {
    // 156x148 (spec section 5.4), 9.75rem x 9.25rem at the default root size.
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={[{ value: "facebook" as const }]}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(html).toContain("w-[9.75rem]");
    expect(html).toContain("min-h-[9.25rem]");
  });

  it("skips a channel it has no mark for instead of drawing an empty tile", () => {
    // An unknown id is a bug in a table, not a screen state. The group keeps
    // the channels it does know rather than taking the step down.
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        // @ts-expect-error deliberately outside the union: this is the guard.
        choices={[{ value: "myspace" }, { value: "facebook" }]}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain("Facebook");
  });

  it("renders nothing rather than an empty fieldset when the vocabulary is missing", () => {
    expect(
      renderToStaticMarkup(
        <ChannelTileGroup
          name="channels"
          legend="Câu hỏi"
          choices={[]}
          values={[]}
          onToggle={noop}
        />,
      ),
    ).toBe("");
  });

  it("caps the entrance stagger, so eight tiles cannot push past the 1.2s ceiling", () => {
    /**
     * THIS IS WHERE THE CAP ACTUALLY BITES. Every other step draws six cards
     * and never reaches it; step 4 draws eight, and an uncapped seventh tile
     * would start at 697.5ms and land at 1222.5ms — past the ceiling that
     * section 10 makes an acceptance criterion. Without this test, deleting
     * `enterIndex` from `ChannelTile` breaks the entrance and nothing goes red.
     */
    const html = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={FOCUS_CHANNELS.map((value) => ({ value }))}
        values={[]}
        onToggle={noop}
      />,
    );

    const indexes = [...html.matchAll(/--enter-index:(\d+)/g)].map((match) => Number(match[1]));
    expect(indexes).toHaveLength(FOCUS_CHANNELS.length);
    expect(FOCUS_CHANNELS.length).toBeGreaterThan(6);
    // 0,1,2,3,4,5 then the tail arrives together on 5.
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 5, 5]);
    expect(Math.max(...indexes)).toBe(5);
  });
});
