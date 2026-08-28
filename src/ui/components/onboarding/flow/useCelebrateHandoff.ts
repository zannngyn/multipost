"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { markHandoffArrival } from "@/ui/hooks/useHandoffArrival";
import { ApiError } from "@/ui/services/api-error";
import {
  fetchSetupProgress,
  setupKeys,
} from "@/ui/services/setup-progress.api";

/**
 * Cú bàn giao: từ màn chúc mừng vào app, không cắt cứng.
 *
 * Tách khỏi `OnboardingFlow` vì nó là một cỗ máy nhỏ có đồng hồ riêng —
 * đếm ngược, huỷ đếm ngược, mờ dần, làm ấm cache — và nhồi cả bốn thứ đó vào
 * một component đã 500 dòng là cách chắc chắn nhất để một trong bốn cái bị sửa
 * hỏng mà không ai thấy.
 *
 * HOOK NÀY KHÔNG ĐIỀU HƯỚNG. Nó chỉ dựng cờ `hasHandedOff`; `OnboardingFlow`
 * mới là chỗ gọi `router.replace`, và đó vẫn là ĐƯỜNG RA DUY NHẤT của luồng —
 * dù người dùng vừa hoàn tất, hay gõ `/onboarding` sau một tuần. Hai chỗ cùng
 * điều hướng là hai lần điều hướng chồng lên nhau.
 */

/**
 * Màn chúc mừng đứng bao lâu trước khi tự đi.
 *
 * Entrance kết thúc ở ~972ms, nên 4s để lại khoảng 3 giây đọc. Đây là một quãng
 * chờ, không phải một khoảng thời lượng chuyển động, nên nó KHÔNG lấy từ thang
 * duration của theme — thang ấy mô tả "một thứ chạy mất bao lâu", không mô tả
 * "chờ bao lâu rồi mới làm gì".
 *
 * PENDING(celebrate-autoadvance): PM chưa chốt 4s hay bỏ hẳn tự động.
 */
const CELEBRATE_DWELL_MS = 4_000;

/**
 * Cú mờ đi trước khi điều hướng.
 *
 * PHẢI KHỚP `--dur-exit` trong `onboarding-motion.css` (= `--duration-medium`).
 * `setTimeout` nhận số, CSS nhận token, nên con số này được giải bằng tay ở đây
 * — đúng loại giá trị âm thầm lệch đi vào ngày theme đổi, nên
 * `onboarding-motion.test.ts` ghim nó vào token.
 *
 * TIMER CHỨ KHÔNG PHẢI `transitionend`. Tab chạy nền không bắn event đó, và một
 * người bấm "Vào MYSP" rồi chuyển tab phải quay lại thấy mình đã ở trong app,
 * không phải kẹt trên một màn chúc mừng trong suốt.
 */
const HANDOFF_FADE_MS = 500;

export interface CelebrateHandoff {
  /** Số giây còn lại, hoặc `null` khi đã huỷ / không bao giờ chạy. */
  readonly secondsLeft: number | null;
  /** Đang mờ dần. Màn vẫn ở trên document, chỉ là không ai chạm được nữa. */
  readonly isLeaving: boolean;
  /** Cờ cho `decideCelebrate` — quyết định đi đã chốt. */
  readonly hasHandedOff: boolean;
  /** Bấm "Vào MYSP", hoặc hết giờ. Gọi nhiều lần cũng chỉ đi một lần. */
  readonly enterApp: () => void;
  /** Dừng đếm ngược vĩnh viễn. Bất kỳ tương tác nào cũng gọi cái này. */
  readonly cancelCountdown: () => void;
}

export function useCelebrateHandoff({
  isCelebrating,
  tenantKey,
}: {
  /** True khi màn chúc mừng đang hiện. Mọi đồng hồ dưới đây treo vào nó. */
  readonly isCelebrating: boolean;
  readonly tenantKey: string;
}): CelebrateHandoff {
  const router = useRouter();
  const queryClient = useQueryClient();
  const prefersReducedMotion = useReducedMotion();
  const isStill = prefersReducedMotion === true;

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const [hasHandedOff, setHasHandedOff] = useState(false);

  /** Đã bắt đầu đi hay chưa. Ref vì cả timer lẫn nút đều có thể tới trước, và
   *  cái thứ hai phải là một no-op chứ không phải một cú fade thứ hai. */
  const hasStartedLeaving = useRef(false);
  /**
   * Đếm ngược đã bị huỷ. STATE chứ không phải ref: dòng chữ đếm ngược biến mất
   * ngay khi nó bật, nên đây là thứ màn hình vẽ theo — mà ref thì không được
   * đọc trong lúc render (`react-hooks/refs`), đúng vì lý do đó.
   */
  const [isCountdownCancelled, setIsCountdownCancelled] = useState(false);

  const enterApp = useCallback(() => {
    // --- Edge case trước: đi hai lần là điều hướng chồng lên nhau -----------
    if (hasStartedLeaving.current) return;
    hasStartedLeaving.current = true;

    setSecondsLeft(null);

    // Giảm chuyển động: không mờ, không chờ. Trạng thái vẫn đổi, chỉ là không
    // có gì chạy quanh nó.
    if (isStill) {
      markHandoffArrival();
      setHasHandedOff(true);
      return;
    }

    setIsLeaving(true);
  }, [isStill]);

  const cancelCountdown = useCallback(() => {
    setIsCountdownCancelled(true);
    setSecondsLeft(null);
  }, []);

  /**
   * Đồng hồ có được phép chạy không. Ba lý do để không:
   * chưa tới màn chúc mừng, người dùng xin giảm chuyển động, hoặc họ đã chạm
   * vào màn hình và đếm ngược bị huỷ vĩnh viễn.
   */
  const shouldCount = isCelebrating && !isStill && !isCountdownCancelled;

  /**
   * Con số đầu tiên, đặt TRONG LÚC RENDER — cùng khuôn với `direction` ở
   * `OnboardingFlow`: nó suy ra từ một giá trị vừa đổi, nên nó thuộc về chính
   * lần render ấy. Đặt state đồng bộ trong thân effect là thứ
   * `react-hooks/set-state-in-effect` chặn, và chặn đúng.
   */
  const [wasCounting, setWasCounting] = useState(false);
  if (shouldCount !== wasCounting) {
    setWasCounting(shouldCount);
    setSecondsLeft(shouldCount ? Math.round(CELEBRATE_DWELL_MS / 1_000) : null);
  }

  /**
   * ĐỒNG HỒ ĐẾM NGƯỢC.
   *
   * Không chạy dưới `reduce`: một màn tự biến mất mà người dùng không dừng được
   * là lỗi WCAG 2.2.1, và người đọc chậm đúng là nhóm cần màn này nhất. Nút
   * "Vào MYSP" luôn là đường đi chính, bấm được ngay từ khung hình đầu.
   */
  useEffect(() => {
    if (!shouldCount || hasStartedLeaving.current) return;

    /*
      HAI ĐỒNG HỒ, VÀ CHỈ MỘT TRONG HAI QUYẾT ĐỊNH ĐIỀU GÌ.

      `deadline` là thứ thật: một `setTimeout` duy nhất đo đúng quãng chờ. Cái
      `interval` chỉ để hiện con số, và nếu trình duyệt bóp nhịp của nó (tab
      nền làm đúng như vậy) thì con số hiện sai chứ quãng chờ không dài ra.

      Đếm bằng cách cộng dồn interval rồi tới 0 mới đi thì ngược lại: nhịp trôi
      là quãng chờ trôi theo, và người dùng chuyển tab một lúc sẽ quay lại thấy
      màn chúc mừng vẫn đứng đó đếm dở.
    */
    const deadline = setTimeout(enterApp, CELEBRATE_DWELL_MS);

    const tick = setInterval(() => {
      setSecondsLeft((previous) => {
        // --- Edge case: đã bị huỷ giữa hai nhịp ------------------------------
        if (previous === null) return null;
        return previous > 1 ? previous - 1 : 1;
      });
    }, 1_000);

    return () => {
      clearTimeout(deadline);
      clearInterval(tick);
    };
  }, [shouldCount, enterApp]);

  /**
   * Hết cú mờ thì dựng cờ. `setTimeout` chứ không phải `transitionend` — xem
   * ghi chú ở `HANDOFF_FADE_MS`.
   */
  useEffect(() => {
    if (!isLeaving) return;

    const timer = setTimeout(() => {
      // Thứ tự quan trọng: cờ phải nằm sẵn trong module TRƯỚC khi điều hướng
      // xảy ra, vì `AppFrame` đọc nó ngay ở lần render đầu tiên của mình.
      markHandoffArrival();
      setHasHandedOff(true);
    }, HANDOFF_FADE_MS);

    // Dọn nếu component chết trước khi timer nổ: một timer sống sót sau unmount
    // sẽ gọi setState trên thứ không còn tồn tại.
    return () => clearTimeout(timer);
  }, [isLeaving]);

  /**
   * LÀM ẤM APP TRONG LÚC NGƯỜI DÙNG ĐANG ĐỌC.
   *
   * `QueryClientProvider` nằm ở root layout, và `router.replace("/overview")` là điều
   * hướng phía client — nên cache sống xuyên qua cú chuyển route và việc
   * prefetch ở đây là thật, không phải trang trí.
   *
   * ĐÚNG HAI THỨ: RSC payload của trang tổng quan, và dữ liệu của `SetupDock` —
   * cái dock sẽ chỉ đúng những bước vừa liệt kê trên màn này, nên nó là thứ duy
   * nhất phải có sẵn để cú bàn giao không kết thúc bằng một ô skeleton.
   * `OverviewScreen` còn năm query nữa; chúng tự có trạng thái chờ của mình, và
   * năm request bắn ra trong lúc người dùng đang đọc chữ là đánh đổi sai.
   */
  useEffect(() => {
    if (!isCelebrating) return;

    router.prefetch("/overview");

    void queryClient
      .prefetchQuery({
        queryKey: setupKeys.progress(tenantKey),
        queryFn: ({ signal }) => fetchSetupProgress(signal),
        staleTime: 30_000,
      })
      .catch((error: unknown) => {
        /*
          NGOẠI LỆ DUY NHẤT của luật "cấm nuốt lỗi" trong luồng này, và nó được
          ghi ra chứ không im: đây là tối ưu, không phải dữ liệu của màn hình.
          `SetupDock` trong app sẽ tự hỏi lại và tự báo lỗi của nó. Làm hỏng cú
          bàn giao vì một lần làm ấm cache thất bại là đổi một thứ không ai thấy
          lấy một thứ ai cũng thấy.
        */
        console.debug("[onboarding] could not warm the setup progress cache", {
          error_code: ApiError.is(error) ? error.code : "UNKNOWN",
          tenant_key: tenantKey,
        });
      });
  }, [isCelebrating, queryClient, router, tenantKey]);

  return { secondsLeft, isLeaving, hasHandedOff, enterApp, cancelCountdown };
}
