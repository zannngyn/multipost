import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cờ bàn giao là trạng thái ở PHẠM VI MODULE, nên nó rò từ test này sang test
 * kia nếu không reset — đúng cái giá đi kèm của cách làm ấy, và là lý do mỗi
 * test dưới đây nạp lại module thay vì import một lần ở đầu file.
 *
 * `useHandoffArrival` bản thân nó cần DOM (vitest chạy `environment: "node"`,
 * repo cố ý không có jsdom) nên KHÔNG được test ở đây. Ba hàm quanh nó thì
 * không cần gì cả, và chúng chứa toàn bộ phần có thể sai.
 */

async function loadModule() {
  vi.resetModules();
  return import("../useHandoffArrival");
}

describe("cờ bàn giao onboarding → app", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("bắt đầu ở trạng thái tắt — một lần tải trang thật không phải là bàn giao", async () => {
    const { peekHandoffArrival } = await loadModule();
    expect(peekHandoffArrival()).toBe(false);
  });

  it("bật lên khi onboarding đánh dấu, và giữ nguyên cho tới khi được tiêu thụ", async () => {
    const { markHandoffArrival, peekHandoffArrival } = await loadModule();

    markHandoffArrival();
    expect(peekHandoffArrival()).toBe(true);
    // Đọc nhiều lần không tiêu thụ nó: `AppFrame` có thể render lại trước khi
    // effect kịp chạy, và cú fade phải sống sót qua lần render ấy.
    expect(peekHandoffArrival()).toBe(true);
  });

  it("đánh dấu hai lần vẫn chỉ là một lần bàn giao", async () => {
    const { markHandoffArrival, clearHandoffArrival, peekHandoffArrival } =
      await loadModule();

    markHandoffArrival();
    markHandoffArrival();
    clearHandoffArrival();
    // Một lần tiêu thụ phải dọn sạch — nếu `mark` cộng dồn, lần vào "/" kế tiếp
    // trong cùng tab sẽ phát lại hiệu ứng mà không ai yêu cầu.
    expect(peekHandoffArrival()).toBe(false);
  });

  it("tiêu thụ khi đang tắt là chuyện vô hại", async () => {
    const { clearHandoffArrival, peekHandoffArrival } = await loadModule();

    clearHandoffArrival();
    expect(peekHandoffArrival()).toBe(false);
  });

  it("không mang trạng thái sang lần nạp module sau — tải lại trang là mất cờ", async () => {
    const first = await loadModule();
    first.markHandoffArrival();
    expect(first.peekHandoffArrival()).toBe(true);

    const second = await loadModule();
    expect(second.peekHandoffArrival()).toBe(false);
  });
});
