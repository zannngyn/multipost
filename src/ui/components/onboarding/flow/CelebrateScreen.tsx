import { ArrowRight, Check } from "lucide-react";

import type { StepView } from "@/ui/components/onboarding/first-run.types";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";

import {
  ENTER_DELAY_CARDS,
  ENTER_DELAY_CELEBRATE_CTA,
  ENTER_DELAY_HEADING,
  ENTER_DELAY_SEAL,
  ENTER_DELAY_SUBHEAD,
  enterDelay,
  enterIndex,
} from "./onboarding-motion";
import "./onboarding-motion.css";

/**
 * Màn cuối: khảo sát đã đóng, và đây là chỗ nói ra điều đó.
 *
 * NÓ KHÔNG PHẢI MỘT CÂU HỎI THỨ NĂM. Không có "Bỏ qua", không có chấm bước thứ
 * năm, không có nút Back — đằng sau nó là một câu hỏi đã trả lời và một
 * `completed_at` đã ghi, nên quay lại là ngõ cụt. Một đường ra duy nhất.
 *
 * DANH SÁCH VIỆC TIẾP THEO LẤY TỪ `SETUP_STEP_PRESENTATION`, KHÔNG VIẾT LẠI.
 * Đây mới là chỗ "mượt" nằm ở: ngay sau cú bàn giao, `SetupDock` trong app sẽ
 * chỉ đúng những dòng này, cùng chữ, cùng thứ tự. Một bản chữ thứ hai là một
 * thứ phải sửa hai lần và là một cơ hội để hai bên nói khác nhau.
 *
 * CÁC DÒNG NÀY KHÔNG PHẢI LINK. Chúng có `href` trong dữ liệu, nhưng bấm vào
 * đây sẽ rời luồng trước khi cú bàn giao kịp chạy — và bỏ qua luôn cả việc làm
 * ấm cache. Dock trong app là chỗ bấm; ở đây chúng chỉ để đọc.
 *
 * PURE component: mọi thứ vào bằng props, nên nó render được dưới
 * `renderToStaticMarkup` trong bộ test không có DOM.
 */

export interface CelebrateScreenProps {
  /** `null` khi tài khoản không có tên hiển thị — xem PENDING(welcome-name). */
  readonly name: string | null;
  /**
   * Tối đa 3 bước thiết lập chưa xong. Rỗng cũng hợp lệ: query có thể chưa về
   * hoặc đã hỏng, và màn này vẫn đủ nghĩa khi thiếu nó.
   */
  readonly nextSteps: readonly StepView[];
  /** Số giây còn lại trước khi tự vào app. `null` = đã tắt đếm ngược. */
  readonly secondsLeft: number | null;
  /** Đang mờ dần để nhường chỗ cho app. */
  readonly isLeaving: boolean;
  readonly onEnter: () => void;
  /**
   * Người dùng vừa chạm vào màn hình. Dùng để huỷ đếm ngược.
   *
   * KHÔNG bắt `focus`. `ScreenLayer` tự đưa focus vào thẻ <h1> ngay khi màn này
   * mount, nên một handler focus sẽ nổ ở mọi lần, cho mọi người, và đếm ngược
   * sẽ không bao giờ chạy. Bấm phím và bấm chuột thì chỉ con người mới làm.
   */
  readonly onInteract?: () => void;
}

export function CelebrateScreen({
  name,
  nextSteps,
  secondsLeft,
  isLeaving,
  onEnter,
  onInteract,
}: CelebrateScreenProps) {
  return (
    /*
      LỚP BÀN GIAO. `data-leaving` chứ không phải một class Tailwind: cú mờ đi
      là một transition khai trong `onboarding-motion.css`, nên nó biến mất
      hoàn toàn dưới `prefers-reduced-motion: reduce` — attribute vẫn đổi, chỉ
      là không có gì đọc nó nữa, và màn hình chuyển ngay.

      `aria-hidden` + `inert` khi đang rời đi: nội dung vẫn còn trên màn hình
      thêm 300ms nữa, và trong 300ms đó không ai được bấm gì thêm.
    */
    <div
      data-slot="celebrate"
      data-leaving={isLeaving ? "true" : "false"}
      aria-hidden={isLeaving ? true : undefined}
      inert={isLeaving}
      onKeyDownCapture={onInteract}
      onPointerDownCapture={onInteract}
      className="onboarding-handoff flex w-full flex-col items-center gap-8"
    >
      {/*
        CON DẤU. Vòng tròn mực đặc, dấu tích màu nền — `text-background` khai
        TƯỜNG MINH, không dựa vào kế thừa: `<Theme>` của Astryx scope
        `--color-text-primary` xuống mọi phần tử chữ bên dưới, và đó đúng bằng
        màu near-black mà vòng tròn này đang dùng làm nền. Không khai màu là
        tàng hình, và bẫy đó chỉ lộ trong app thật chứ không lộ ở trang preview.
      */}
      <div style={enterDelay(ENTER_DELAY_SEAL)} className="relative size-16">
        {/* Quầng. Trang trí thuần tuý — con dấu bên cạnh mới là thứ mang nghĩa,
            nên nó `aria-hidden` và nó vắng mặt hoàn toàn dưới `reduce`. */}
        <span
          aria-hidden="true"
          className="onboarding-halo border-foreground/30 absolute inset-0 rounded-full border"
        />
        <span className="onboarding-seal-in bg-foreground text-background flex size-16 items-center justify-center rounded-full">
          <Check aria-hidden="true" className="size-7" />
        </span>
      </div>

      {/*
        Cùng cỡ chữ và cùng khuôn với `WelcomeScreen` — hai màn này là hai đầu
        của cùng một luồng và phải nhìn ra là một cặp.

        `tabIndex={-1}`: đổi màn là điều hướng, nên `ScreenLayer` đưa focus vào
        đúng thẻ <h1> này khi màn chúc mừng mount.
      */}
      <h1
        tabIndex={-1}
        style={enterDelay(ENTER_DELAY_HEADING)}
        className="onboarding-enter text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        <span className="block">
          {name === null ? "Xong rồi 🎉" : `Xong rồi, ${name} 🎉`}
        </span>
        <span className="block">MYSP đã hiểu xưởng của bạn</span>
      </h1>

      <p
        style={enterDelay(ENTER_DELAY_SUBHEAD)}
        className="onboarding-enter-fade text-muted-foreground max-w-[34rem] text-center text-sm"
      >
        Câu trả lời của bạn đã được lưu. Từ giờ MYSP sẽ gợi ý caption và kênh
        đăng theo đúng mặt hàng bạn bán.
      </p>

      {/* Ẩn cả khối khi không có dữ liệu — không skeleton, không câu lỗi. Một
          thông báo hỏng trên màn ăn mừng là thứ tệ nhất có thể đặt ở đây, và
          nút "Vào MYSP" không phụ thuộc vào query này. */}
      {nextSteps.length > 0 ? (
        <div className="flex w-full max-w-[26rem] flex-col gap-3">
          <div
            style={enterDelay(ENTER_DELAY_CARDS)}
            className="onboarding-enter-fade"
          >
            <Eyebrow className="text-center">
              Còn {nextSteps.length} bước để đăng bài đầu tiên
            </Eyebrow>
          </div>

          <ul className="flex flex-col gap-2">
            {nextSteps.map((step, index) => (
              /* Entrance trên <li> (là wrapper), nội dung ở lớp trong. Không
                 element nào vừa mang class entrance vừa mang utility
                 opacity/scale — luật của cả thư mục này. */
              <li
                key={step.id}
                style={{
                  ...enterDelay(ENTER_DELAY_CARDS),
                  ...enterIndex(index),
                }}
                className="onboarding-enter"
              >
                <div className="border-border bg-card flex items-start gap-3 rounded-lg border px-4 py-3">
                  <span
                    aria-hidden="true"
                    className="bg-secondary text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs"
                  >
                    {step.ordinal}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-foreground text-sm font-medium">
                      {step.title}
                    </span>
                    <span className="text-muted-foreground text-xs leading-relaxed">
                      {step.description}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-3">
        {/* Entrance trên wrapper, nút ở trong: `buttonVariants` đặt
            `disabled:opacity-50` và `transition-all` lên chính element nút, và
            một keyframe đang chạy thắng cả ba cho tới khi nó kết thúc. */}
        <div
          style={enterDelay(ENTER_DELAY_CELEBRATE_CTA)}
          className="onboarding-enter"
        >
          <Button
            type="button"
            onClick={onEnter}
            className="bg-foreground text-background hover:bg-foreground/90 h-12 gap-2 rounded-lg px-6 text-sm font-medium"
          >
            Vào MYSP
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>

        {/*
          VÙNG LIVE CÓ MẶT TỪ KHUNG HÌNH ĐẦU, chỉ NỘI DUNG của nó đổi. Một
          `role="status"` được chèn vào cùng lúc với chữ của nó thường không
          được đọc, vì lúc ấy chưa có gì để trình đọc màn hình theo dõi.

          Đếm ngược tắt hẳn khi người dùng chạm vào bất cứ thứ gì (và không bao
          giờ khởi động dưới `reduce`) — WCAG 2.2.1: một màn tự biến mất mà
          không dừng được là lỗi, và người đọc chậm đúng là nhóm cần màn này
          nhất. Nút bên trên luôn là đường đi chính.
        */}
        <p
          role="status"
          className="text-muted-foreground h-4 text-center text-xs"
        >
          {secondsLeft !== null ? `Tự động vào sau ${secondsLeft}s` : null}
        </p>
      </div>
    </div>
  );
}
