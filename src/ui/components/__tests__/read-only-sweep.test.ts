import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The M3.3 sweep, as an invariant: every screen that can WRITE consults the
 * read-only reason, so support mode never shows a button whose only outcome is
 * a 403.
 *
 * WHY IT IS A STRUCTURAL TEST, NOT A RENDERING ONE: `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom or testing-library. Adding
 * either is a dependency decision this ticket does not authorise, so the
 * behaviour of the decision is covered in `hooks/read-only-gate.test.ts` and
 * the WIRING is covered here. It catches the regression that actually happens:
 * a new write button lands on one of these screens, or a refactor drops the
 * hook, and nobody notices until a support session hits a 403.
 *
 * Deliberately coarse — "does this file consult the reason at all" — so honest
 * refactors do not break it.
 */

const GATED_SURFACES = [
  {
    screen: "Nhóm kênh",
    file: "channels/ChannelGroupsScreen.tsx",
    writes: "tạo / sửa / xoá nhóm",
  },
  { screen: "Chạy hàng loạt", file: "bulk/BulkRunScreen.tsx", writes: "nút chạy lô" },
  {
    screen: "Bài đã hẹn",
    file: "scheduled/ScheduledScreen.tsx",
    writes: "huỷ / đổi giờ (bảng nhận qua prop)",
  },
  { screen: "Nhật ký đăng", file: "jobs/JobLogScreen.tsx", writes: "chạy lại một bài" },
  {
    screen: "Mẫu prompt",
    file: "prompts/PromptTemplatesScreen.tsx",
    writes: "tạo phiên bản / kích hoạt",
  },
  { screen: "Đổi nguồn dữ liệu", file: "sync/CatalogSourceCard.tsx", writes: "đổi nguồn Drive/Sheet" },
  // Gated in M3.3 itself; kept here so the set cannot shrink unnoticed.
  // The wave-1 IA split this screen into a hub and its panels: the hub is now
  // the one place the reason is read, and it hands the block down to the two
  // panels that write (see PROP_FED below).
  { screen: "Kênh", file: "channels/ChannelsHub.tsx", writes: "bật/tắt, gỡ, nhập token" },
  { screen: "Đồng bộ", file: "sync/SyncScreen.tsx", writes: "chạy đồng bộ" },
  // Onboarding phase 1: saving a field map rewrites how the WHOLE catalog is
  // read, and turning the stock gate off suspends business rule 3 for the
  // tenant. Neither may be offered to somebody reading over the owner's
  // shoulder in a support session.
  {
    screen: "Kết nối dữ liệu",
    file: "onboarding/DataMappingScreen.tsx",
    writes: "lưu ánh xạ cột + chế độ kiểm tồn (bảng nhận qua prop)",
  },
] as const;

/**
 * The components that receive the reason instead of reading the hook. `token`
 * is the prop each one is fed by the screen above it — a component that ignored
 * it would silently keep its buttons live in a support session.
 */
const PROP_FED_TABLES = [
  { component: "ScheduledJobTable", file: "scheduled/ScheduledJobTable.tsx", token: "readOnlyReason" },
  { component: "JobLogTable", file: "jobs/JobLogTable.tsx", token: "readOnlyReason" },
  {
    component: "ConnectedChannelsScreen",
    file: "channels/ConnectedChannelsScreen.tsx",
    token: "areWritesBlocked",
  },
  {
    component: "ChannelConnectPanel",
    file: "channels/ChannelConnectPanel.tsx",
    token: "areWritesBlocked",
  },
  {
    component: "FieldMapForm",
    file: "onboarding/FieldMapForm.tsx",
    token: "readOnlyReason",
  },
] as const;

function read(relative: string): string {
  const url = new URL(relative, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("support mode: every write surface consults the read-only reason", () => {
  for (const surface of GATED_SURFACES) {
    it(`${surface.screen} gates ${surface.writes}`, () => {
      const source = read(`../${surface.file}`);
      expect(source).toContain("useReadOnlyReason");
      // …and actually calls it, rather than importing it and forgetting.
      expect(source).toMatch(/useReadOnlyReason\(\)/);
    });
  }

  for (const table of PROP_FED_TABLES) {
    it(`${table.component} takes the reason from its screen`, () => {
      const source = read(`../${table.file}`);
      // These render the control, so they must receive the reason — a component
      // that ignores the prop would silently keep its buttons live.
      expect(source).toContain(table.token);
    });
  }
});

describe("the sweep's scope is written down", () => {
  it("covers the six screens of the ticket, the two already done, and onboarding", () => {
    expect(GATED_SURFACES).toHaveLength(9);
    // Soạn bài is deliberately absent: another agent is rebuilding
    // `components/compose/**` and this sweep must not touch it.
    expect(GATED_SURFACES.map((surface) => surface.file).join(" ")).not.toContain("compose/");
  });
});
