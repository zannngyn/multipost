import { describe, expect, it } from "vitest";

import { decideCelebrate, type CelebrateDecision } from "../celebrate-stage";

/**
 * Cả 12 tổ hợp của ba đầu vào (2 × 3 × 2), kể cả những tổ hợp không xảy ra
 * trong thực tế.
 *
 * Lý do test hết: hai trong ba đầu vào là ảnh chụp của cùng một trường dữ liệu
 * ở hai thời điểm, nên một lần sửa sau làm lệch thời điểm chụp sẽ tạo ra đúng
 * những tổ hợp "không thể xảy ra" này. Bảng đầy đủ nói cho người sửa biết hàm
 * PHẢI làm gì lúc đó, thay vì để họ đoán.
 */

const AT = "2026-08-27T03:00:00.000Z";
const EARLIER = "2026-08-20T09:00:00.000Z";

const CASES: ReadonlyArray<{
  readonly completedAt: string | null;
  readonly completedAtOnArrival: string | null | undefined;
  readonly hasHandedOff: boolean;
  readonly expected: CelebrateDecision;
  readonly why: string;
}> = [
  // --- khảo sát chưa đóng --------------------------------------------------
  {
    completedAt: null,
    completedAtOnArrival: null,
    hasHandedOff: false,
    expected: "flow",
    why: "đang trả lời câu hỏi — trạng thái thường gặp nhất",
  },
  {
    completedAt: null,
    completedAtOnArrival: undefined,
    hasHandedOff: false,
    expected: "flow",
    why: "hồ sơ vừa về, còn mở",
  },
  {
    completedAt: null,
    completedAtOnArrival: EARLIER,
    hasHandedOff: false,
    expected: "flow",
    why: "không xảy ra thật (đã đóng rồi mở lại); còn mở thì còn hỏi",
  },
  {
    completedAt: null,
    completedAtOnArrival: null,
    hasHandedOff: true,
    expected: "leave",
    why: "không xảy ra thật; đã quyết định đi thì cứ đi",
  },
  {
    completedAt: null,
    completedAtOnArrival: undefined,
    hasHandedOff: true,
    expected: "leave",
    why: "như trên",
  },
  {
    completedAt: null,
    completedAtOnArrival: EARLIER,
    hasHandedOff: true,
    expected: "leave",
    why: "như trên",
  },
  // --- khảo sát đã đóng ----------------------------------------------------
  {
    completedAt: AT,
    completedAtOnArrival: null,
    hasHandedOff: false,
    expected: "celebrate",
    why: "lúc vào còn mở, giờ đã đóng — ĐÚNG MỘT đường duy nhất tới màn chúc mừng",
  },
  {
    completedAt: AT,
    completedAtOnArrival: EARLIER,
    hasHandedOff: false,
    expected: "leave",
    why: "tenant hoàn tất từ trước gõ /onboarding — KHÔNG được chúc mừng lại",
  },
  {
    completedAt: AT,
    completedAtOnArrival: undefined,
    hasHandedOff: false,
    expected: "leave",
    why: "hồ sơ đọc được lần đầu đã thấy đóng: đóng từ trước khi màn này tồn tại",
  },
  {
    completedAt: AT,
    completedAtOnArrival: null,
    hasHandedOff: true,
    expected: "leave",
    why: "chúc mừng xong, đang bàn giao",
  },
  {
    completedAt: AT,
    completedAtOnArrival: EARLIER,
    hasHandedOff: true,
    expected: "leave",
    why: "đang đi rồi",
  },
  {
    completedAt: AT,
    completedAtOnArrival: undefined,
    hasHandedOff: true,
    expected: "leave",
    why: "đang đi rồi",
  },
];

describe("decideCelebrate", () => {
  for (const row of CASES) {
    const arrival =
      row.completedAtOnArrival === undefined
        ? "undefined"
        : row.completedAtOnArrival === null
          ? "null"
          : "set";
    it(`now=${row.completedAt === null ? "null" : "set"} arrival=${arrival} handedOff=${row.hasHandedOff} → ${row.expected} (${row.why})`, () => {
      expect(
        decideCelebrate({
          completedAt: row.completedAt,
          completedAtOnArrival: row.completedAtOnArrival,
          hasHandedOff: row.hasHandedOff,
        }),
      ).toBe(row.expected);
    });
  }

  it("phủ hết 2 × 3 × 2 tổ hợp — không có nhánh nào chưa ai nhìn", () => {
    expect(CASES).toHaveLength(12);
    // Không có dòng nào trùng đầu vào với dòng khác — nếu trùng thì bảng "đầy
    // đủ" ở trên đang bỏ sót một nhánh mà vẫn đếm đủ 12.
    const keys = CASES.map(
      (row) => `${row.completedAt}|${String(row.completedAtOnArrival)}|${row.hasHandedOff}`,
    );
    expect(new Set(keys).size).toBe(12);
  });

  it("chỉ có đúng MỘT tổ hợp dẫn tới màn chúc mừng", () => {
    // Khẳng định thật của cả file: màn chúc mừng là ngoại lệ hẹp, không phải
    // trạng thái mặc định của "đã xong". Nếu một lần sửa sau nới nó ra, dòng
    // này đỏ trước khi có ai đó bị chúc mừng hai lần.
    const celebrating = CASES.filter((row) => row.expected === "celebrate");
    expect(celebrating).toHaveLength(1);
    expect(celebrating[0]).toMatchObject({ completedAtOnArrival: null, hasHandedOff: false });
  });
});
