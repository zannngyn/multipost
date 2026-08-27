import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SETUP_STEP_PRESENTATION,
  buildStepViews,
} from "@/ui/components/onboarding/setup-steps";
import type { SetupProgress } from "@/ui/schemas/setup-progress.schema";

import { CelebrateScreen } from "./CelebrateScreen";

/**
 * `renderToStaticMarkup`, không phải testing-library: vitest chạy
 * `environment: "node"` và repo cố ý không có jsdom. `CelebrateScreen` là
 * component thuần nên nó render được ở đây trọn vẹn.
 *
 * NHỮNG GÌ FILE NÀY KHÔNG CHỨNG MINH, ghi ra để một bộ test xanh không bị đọc
 * nhầm thành "đã phủ": đếm ngược thật sự chạy, huỷ đếm ngược khi chạm màn hình,
 * cú mờ 300ms trước `router.replace`, và cờ bàn giao sống sót qua cú chuyển
 * route. Bốn thứ đó là trạng thái đổi theo THỜI GIAN trong một document thật.
 * Chỉ trình duyệt chứng minh được, và đó là lượt Playwright mà PM chạy.
 */

const OPEN_PROGRESS: SetupProgress = {
  tenantId: "t1",
  steps: SETUP_STEP_PRESENTATION.map((step) => ({
    id: step.id,
    isDone: false,
  })),
  doneCount: 0,
  requiredCount: SETUP_STEP_PRESENTATION.length,
  isReady: false,
};

const THREE_STEPS = buildStepViews(OPEN_PROGRESS)
  .filter((step) => step.state !== "done")
  .slice(0, 3);

const noop = () => {};

function render(
  overrides: Partial<Parameters<typeof CelebrateScreen>[0]> = {},
) {
  return renderToStaticMarkup(
    <CelebrateScreen
      name="Vân"
      nextSteps={THREE_STEPS}
      secondsLeft={4}
      isLeaving={false}
      onEnter={noop}
      {...overrides}
    />,
  );
}

describe("CelebrateScreen", () => {
  it("mang đúng một <h1>, và nó nhận được focus khi màn đổi", () => {
    const html = render();
    // `ScreenLayer` tìm <h1> đầu tiên trong layer và focus vào đó. Không có
    // `tabindex="-1"` thì lời gọi `.focus()` ấy im lặng không làm gì.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('tabindex="-1"');
  });

  it("chào bằng tên khi có, và không để lại chỗ trống khi không có", () => {
    expect(render()).toContain("Xong rồi, Vân 🎉");
    const nameless = render({ name: null });
    expect(nameless).toContain("Xong rồi 🎉");
    // PENDING(welcome-name): `/api/me` không có email, nên không có gì để bịa
    // ra một cái tên. Câu chào không tên là câu chào đúng, không phải "Xong
    // rồi,  🎉" với một lỗ ở giữa.
    expect(nameless).not.toContain("Xong rồi, ");
  });

  it("giữ vùng live có mặt từ khung hình đầu, kể cả khi không đếm ngược", () => {
    // Một `role="status"` được chèn vào cùng lúc với chữ của nó thường không
    // được đọc: lúc ấy chưa có gì để trình đọc màn hình theo dõi.
    const counting = render({ secondsLeft: 3 });
    expect(counting).toContain('role="status"');
    expect(counting).toContain("Tự động vào sau 3s");

    const silent = render({ secondsLeft: null });
    expect(silent).toContain('role="status"');
    expect(silent).not.toContain("Tự động vào sau");
  });

  it("lấy nguyên chữ của các bước thiết lập, không viết lại", () => {
    /**
     * KHẲNG ĐỊNH QUAN TRỌNG NHẤT CỦA FILE NÀY. Danh sách ở màn chúc mừng và
     * danh sách trong `SetupDock` ngay sau cú bàn giao phải là MỘT — cùng chữ,
     * cùng thứ tự. Một bản chép tay thứ hai là một thứ phải sửa hai lần, và là
     * cách để hai màn hình liền nhau nói khác nhau về cùng một việc.
     */
    const html = render();
    for (const step of THREE_STEPS) {
      expect(html).toContain(step.title);
      expect(html).toContain(step.description);
    }
    expect(THREE_STEPS.map((step) => step.title)).toEqual(
      SETUP_STEP_PRESENTATION.slice(0, 3).map((step) => step.title),
    );
  });

  it("các dòng việc là danh sách thật, và KHÔNG phải link", () => {
    const html = render();
    expect(html.match(/<li/g)).toHaveLength(THREE_STEPS.length);
    // Bấm vào đây sẽ rời luồng trước khi cú bàn giao kịp chạy — và bỏ qua luôn
    // cả việc làm ấm cache. Dock trong app mới là chỗ bấm.
    expect(html).not.toContain("<a ");
  });

  it("ẩn cả khối việc khi không có dữ liệu, nhưng KHÔNG ẩn đường vào app", () => {
    // Query tiến trình có thể chưa về hoặc đã hỏng. Màn chúc mừng vẫn đúng khi
    // thiếu nó, và một câu lỗi trên màn ăn mừng là thứ tệ nhất đặt ở đây.
    const html = render({ nextSteps: [] });
    expect(html).not.toContain("<li");
    expect(html).not.toContain("Còn ");
    expect(html).toContain("Vào MYSP");
  });

  it("đếm số bước còn lại theo đúng số dòng vẽ ra", () => {
    expect(render({ nextSteps: THREE_STEPS.slice(0, 2) })).toContain(
      "Còn 2 bước",
    );
    expect(render()).toContain("Còn 3 bước");
  });

  it("không có Bỏ qua, không có đường quay lại — khảo sát đã đóng", () => {
    const html = render();
    expect(html).not.toContain("Bỏ qua");
    expect(html).not.toContain("Quay lại");
  });

  it("khoá màn hình lại trong lúc đang rời đi", () => {
    // Nội dung còn trên document thêm 300ms nữa trong lúc mờ dần. Trong 300ms
    // đó không ai được bấm gì thêm — kể cả bằng bàn phím.
    const leaving = render({ isLeaving: true });
    expect(leaving).toContain('data-leaving="true"');
    expect(leaving).toContain("inert");
    expect(leaving).toContain('aria-hidden="true"');

    const settled = render();
    expect(settled).toContain('data-leaving="false"');
  });

  it("vẽ con dấu bằng token, và khai màu chữ trên nền tối tường minh", () => {
    const html = render();
    expect(html).toContain("onboarding-seal-in");
    // `<Theme>` của Astryx scope `--color-text-primary` xuống mọi phần tử chữ,
    // và đó đúng bằng màu near-black mà `bg-foreground` dùng làm nền. Không
    // khai `text-background` là dấu tích tàng hình — bẫy chỉ lộ trong app thật.
    expect(html).toContain("bg-foreground");
    expect(html).toContain("text-background");
    // Không phải màu dye: nút chính của cả luồng này là mực trên kem.
    expect(html).not.toContain("bg-primary");
  });

  it("cho quầng trang trí ra khỏi cây ngữ nghĩa", () => {
    const html = render();
    expect(html).toContain("onboarding-halo");
    // Con dấu bên cạnh mới là thứ mang nghĩa; quầng chỉ là ánh sáng quanh nó.
    const halo = /<span[^>]*onboarding-halo[^>]*>/.exec(html)?.[0] ?? "";
    expect(halo).toContain('aria-hidden="true"');
  });

  it("đi trên đúng timeline của luồng, không phải một đồng hồ riêng", () => {
    const html = render();
    expect(html).toContain("--enter-delay:60ms"); // con dấu
    expect(html).toContain("--enter-delay:100ms"); // tiêu đề
    expect(html).toContain("--enter-delay:180ms"); // câu phụ
    expect(html).toContain("--enter-delay:260ms"); // hàng việc
    expect(html).toContain("--enter-delay:calc(260ms + 3 * var(--stagger))"); // nút
    expect([...html.matchAll(/--enter-index:(\d+)/g)].map((m) => m[1])).toEqual(
      ["0", "1", "2"],
    );
  });
});

describe("màn chúc mừng: entrance không bao giờ chung element với state", () => {
  /**
   * CÙNG LUẬT VỚI `option-card-render.test.tsx`, áp cho các class động MỚI của
   * màn này.
   *
   * Giá trị của một animation đang chạy đến từ animation origin, thắng mọi khai
   * báo của author suốt thời gian nó chạy. Nên một element được mang class
   * entrance HOẶC một utility opacity/scale — không bao giờ cả hai.
   *
   * Regex ở đây rộng hơn bản gốc đúng một chỗ: nó nhận cả `onboarding-seal-in`
   * và `onboarding-halo`, hai class có keyframe riêng của màn này.
   */
  const ANIMATED =
    /class="([^"]*\b(?:onboarding-enter[a-z-]*|onboarding-seal-in|onboarding-halo)\b[^"]*)"/g;
  const COLLIDING_UTILITY = /(^|:)-?(opacity|scale)-/;

  it("nhận ra utility va chạm kể cả khi nó nấp sau tiền tố variant", () => {
    // Bản đầu của regex này neo vào `^` và mù với `disabled:opacity-50` — đúng
    // class mà `buttonVariants` đặt lên mọi `Button`, tức là thứ nó sinh ra để
    // bắt. Ghim lại ở đây thay vì tin.
    for (const name of [
      "opacity-45",
      "disabled:opacity-50",
      "hover:scale-105",
    ]) {
      expect(COLLIDING_UTILITY.test(name), `${name} phải bị bắt`).toBe(true);
    }
    for (const name of ["bg-opacity-50", "opacity"]) {
      expect(COLLIDING_UTILITY.test(name), `${name} phải được bỏ qua`).toBe(
        false,
      );
    }
  });

  it("giữ disabled:opacity-50 của Button ra khỏi element đang chạy keyframe", () => {
    const html = render();

    // Bằng chứng là khối markup này THẬT SỰ có thứ để va chạm — nếu không, câu
    // khẳng định bên dưới sẽ xanh trên một đống rơm rỗng.
    expect(html).toContain("disabled:opacity-50");

    const animated = [...html.matchAll(ANIMATED)].map((match) => match[1]);
    // Con dấu, quầng, tiêu đề, câu phụ, nhãn nhóm, 3 hàng việc, nút = 9.
    expect(animated.length).toBe(9);
    expect(
      animated.filter((classList) =>
        classList.split(/\s+/).some((name) => COLLIDING_UTILITY.test(name)),
      ),
    ).toEqual([]);
  });
});
