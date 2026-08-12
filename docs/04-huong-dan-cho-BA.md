# Hướng dẫn cho BA — Dự án Công cụ đăng bài tự động

Tài liệu này nói **BA làm gì, theo thứ tự nào, ra sản phẩm gì**. Thời lượng đề xuất: 2 tuần (10 ngày làm việc).

---

## Nguyên tắc chung

1. **Không hỏi những gì tự tra được.** Stakeholder bận và không nhớ chi tiết dữ liệu. Mở Drive đếm file, export Sheet ra CSV — nhanh hơn và chính xác hơn hỏi.
2. **Mọi tiêu chí phải đo được.** "Caption khác nhau hoàn toàn" không phải yêu cầu, đó là mong muốn. "Không trùng quá 8 từ liên tiếp" mới là yêu cầu.
3. **Giả định phải viết ra.** Không có đáp án thì ghi giả định vào Assumption Log, gán người phải xác nhận và hạn chót. Giả định ngầm là nguồn gốc của mọi cuộc cãi vã lúc nghiệm thu.
4. **Requirement không có tiêu chí chấp nhận thì chưa xong.** Không đưa vào backlog.
5. **Không tự quyết thay stakeholder** những việc thuộc về kinh doanh (ví dụ: có chấp nhận TikTok đăng riêng tư không). Trình bày lựa chọn kèm hệ quả, để họ chọn.

---

## Ngày 1–2: Hiểu bối cảnh và dựng bộ từ vựng

**Việc làm**

- Đọc kỹ brief, đánh dấu mọi chỗ mơ hồ (đã có danh sách sẵn ở `01-cau-hoi-lam-ro-cho-BA.md`).
- Dựng **Glossary** — thống nhất cách gọi: "mã sản phẩm", "màu", "số đuôi", "kênh", "lô", "bài", "job". Hiện brief gọi lẫn "bài" và "post"; team cần một cách gọi duy nhất.
- Vẽ **sơ đồ bối cảnh**: ai dùng, hệ thống chạm vào những nguồn dữ liệu nào, dữ liệu đi ra đâu.

**Sản phẩm**
- `glossary.md`
- `context-diagram` (một hình, không cần đẹp)

---

## Ngày 2–4: Thẩm định khảo sát dữ liệu ⭐ (v2: PM + AI agent đã khảo sát, BA thẩm định)

> **v2 (12/08/2026):** phần khảo sát thô không còn là việc của BA. PM + AI agent query trực tiếp Drive "Ảnh AI" và Sheet "Mẫu 2026" (qua Google Drive MCP), kết quả nằm ở **`05-data-profile.md`** và **`sample-data/`**. Việc của BA trong 3 ngày này là **thẩm định và diễn giải nghiệp vụ** — máy đếm được nhưng không biết cái nào là bất thường có chủ đích.

**Việc làm**

1. **Đọc `05-data-profile.md`**, đối chiếu từng con số với hiểu biết nghiệp vụ:
   - Tỉ lệ file sai chuẩn đặt tên — sai do lỗi gõ, hay do một quy ước khác chưa ai kể? (hỏi người quản lý Drive)
   - Danh sách giá trị cột *Tồn* / *Lưu ý* — giá trị lạ nào là cố ý (quy ước nội bộ) và nghĩa là gì?
   - Mã có ảnh nhưng vắng trên Sheet — là hàng chưa lên sheet, hay hàng đã ngừng bán?

2. **Xác nhận 5 mã mẫu** trong `sample-data/` đúng là đại diện (nhiều màu · một màu · có video · hết hàng · tồn ≤ 3). Đổi mã nếu biết ca tốt hơn.

3. **Chuyển bất thường thành câu hỏi workshop** — mỗi phát hiện lạ trong data-profile thành một dòng trong agenda ngày 4–5, kèm số liệu dẫn chứng.

4. **Vẫn hỏi stakeholder các câu quy trình con người** mà query không trả lời được: B5 (ai sửa/xoá file), B6 (Service Account được không), B12 (ai giữ cấu trúc Sheet), B13 (có nguồn tồn chính xác hơn không).

**Sản phẩm**
- `05-data-profile.md` đã có ghi chú thẩm định của BA (phần "Nhận định nghiệp vụ")
- Danh sách bất thường → đưa vào agenda workshop

**Vì sao vẫn quan trọng:** máy trả lời "bao nhiêu", BA trả lời "vì sao và có sao không". Bỏ bước thẩm định là mang nguyên bất thường vào code.

---

## Ngày 4–5: Workshop làm rõ với stakeholder

**Chuẩn bị trước buổi họp**
- Gửi trước bộ câu hỏi 🔴 (chỉ nhóm 🔴, 30 câu — đừng gửi cả 60 câu, sẽ không ai đọc).
- Gửi trước kết quả `05-data-profile.md` — có số liệu thật thì cuộc họp đi thẳng vào quyết định thay vì phỏng đoán.
- **Đặt riêng một buổi cho nhóm A (quyền truy cập nền tảng), mời IT tham gia.** Nhóm này quyết định cả tiến độ dự án, không được gộp chung vào buổi chung rồi bàn qua loa.

**Trong buổi họp**
- Đi theo thứ tự A → B → C → D → E → F.
- Với mỗi câu chưa có đáp án: gán **người chịu trách nhiệm** và **hạn chót**, không để lửng.
- Với câu thuộc quyết định kinh doanh (A6, D9, F5, F7): trình bày các lựa chọn và hệ quả, rồi **để họ chọn**. Ghi lại người quyết định.

**Sau buổi họp**
- Gửi biên bản trong vòng 24h, kèm danh sách quyết định và danh sách việc còn treo.
- Cập nhật `assumption-log.md`.

**Sản phẩm**
- `workshop-notes.md`
- `decision-log.md` — mỗi dòng: quyết định · người quyết · ngày · lý do
- `assumption-log.md` — mỗi dòng: giả định · người xác nhận · hạn · trạng thái

---

## Ngày 6–7: Mô hình hoá luồng và quy tắc

**Việc làm**

1. **Sơ đồ luồng nghiệp vụ** cho hai chế độ A và B, có nhánh lỗi. Vẽ theo swimlane: Người vận hành / Hệ thống / Nền tảng ngoài.

2. **Máy trạng thái bài đăng** — liệt kê đủ trạng thái và điều kiện chuyển:
   ```
   nháp → có caption → đã duyệt → chờ đăng → đang đăng → đã đăng
                                                     ├──→ lỗi
                              (hết hàng / người huỷ) └──→ đã huỷ
   ```
   Với mỗi trạng thái: ai thấy được, làm được gì, chuyển đi đâu.

3. **Bảng quyết định tồn kho** — dạng bảng, không dạng văn xuôi:

   | Tồn | Cột Lưu ý | Kết quả | Thông báo |
   |---|---|---|---|
   | 0 | bất kỳ | Chặn | "Mã [X] đã hết hàng — không đăng" |
   | trống / không phải số | bất kỳ | *(cần chốt)* | |
   | 1–3 | bất kỳ | Đăng | "Tồn thấp — không nhận sx 1c" (chỉ hiện trên màn hình) |
   | > 3 | = "HẾT HÀNG" | Chặn | như trên |
   | > 3 | khác | Đăng | — |

   Ô *(cần chốt)* chính là câu B8. Bảng làm lộ ra chỗ trống của brief — đó là mục đích của nó.

4. **Bảng quyết định chọn ảnh** — 3 chế độ ở brief mục 4.2, mỗi chế độ liệt kê rõ: đầu vào · ảnh nào được chọn · thứ tự · ảnh bìa · số lượng tối thiểu/tối đa · xử lý khi thiếu.

**Sản phẩm**
- `flows/` — sơ đồ luồng chế độ A, chế độ B, luồng hẹn lịch
- `state-machine.md`
- `decision-tables.md`

---

## Ngày 8–9: Viết user story và tiêu chí chấp nhận

**Định dạng chuẩn** — mỗi story gồm:

```
ID:      US-014
Story:   Là người vận hành, tôi muốn nhập danh sách số đuôi ảnh
         để đăng đúng những ảnh tôi chọn theo đúng thứ tự.
Epic:    E3 — Chọn màu & chọn ảnh
Nguồn:   Brief mục 4.2
Truy vết: Tiêu chí nghiệm thu #4 (brief mục 10)

Tiêu chí chấp nhận:
  AC1  Cho một mã có ảnh số 1..30
       Khi tôi nhập "25, 3, 7"
       Thì hệ thống chọn đúng 3 ảnh, theo thứ tự 25 → 3 → 7
       Và ảnh số 25 là ảnh bìa
       Và không áp quy tắc tối thiểu 5 ảnh

  AC2  Cho một mã có ảnh số 1..30
       Khi tôi nhập "3, 7, 99"
       Thì hệ thống báo lỗi nêu rõ "không tìm thấy ảnh số 99"
       Và <chặn cả bài | đăng 2 ảnh còn lại>   ← chốt ở câu C5

Ngoài phạm vi: sắp xếp lại thứ tự bằng kéo-thả (thuộc chế độ B, US-031)
```

**Quy tắc bắt buộc**
- Mỗi story phải **truy vết ngược** về một mục trong brief và (nếu có) về một tiêu chí ở mục 10.
- Mỗi tiêu chí chấp nhận phải **kiểm chứng được bằng cách chạy thử**. Nếu QA không thể tự xác định đạt hay không đạt, tiêu chí đó chưa đạt chuẩn.
- Chỗ nào còn chờ quyết định thì viết `← chốt ở câu Xn` ngay trong tiêu chí. Đừng đoán bừa rồi để trôi.
- **Viết đủ tiêu chí cho ca lỗi**, không chỉ ca thuận. Brief nhấn mạnh "không được bỏ qua im lặng" — mỗi chỗ như vậy cần một tiêu chí riêng.

**Ma trận truy vết** — bảng đối chiếu 15 tiêu chí nghiệm thu ở brief mục 10 với các story tương ứng. Tiêu chí nào chưa có story nào phủ là lỗ hổng scope, phải bổ sung ngay.

**Sản phẩm**
- `user-stories.md` (hoặc backlog trên Jira/Linear)
- `traceability-matrix.md`

---

## Ngày 10: Rà soát khả thi và chốt baseline

**Việc làm**

1. **Họp rà soát với dev** — đi qua từng story, dev đánh dấu:
   - Rõ, làm được → đưa vào backlog
   - Rõ nhưng tốn hơn dự kiến nhiều → báo lại PM để cân nhắc scope
   - Chưa đủ rõ để code → trả lại BA làm rõ tiếp

2. **Rà soát Definition of Ready** — story chỉ vào sprint khi:
   - [ ] Có tiêu chí chấp nhận kiểm chứng được
   - [ ] Không còn ô `← chốt ở câu Xn` nào
   - [ ] Có dữ liệu mẫu để test
   - [ ] Đã truy vết về brief
   - [ ] Dev đã ước lượng

3. **Chốt baseline** — đóng băng phạm vi Phase 1. Từ đây mọi thay đổi đi qua quy trình đổi phạm vi.

**Sản phẩm**
- Backlog Phase 1 đã sẵn sàng
- `scope-baseline-v1.md`

---

## Quy trình sau khi baseline: quản lý thay đổi

Yêu cầu sẽ thay đổi — chuyện bình thường. Vấn đề là thay đổi **không được đi lối tắt**.

Mỗi đề nghị thay đổi cần ghi:

```
Đề nghị:        <mô tả>
Người đề nghị:  <ai>  Ngày: <ngày>
Lý do:          <vì sao cần>
Ảnh hưởng:      +X MD · chạm vào story nào · có phải sửa schema không
Quyết định:     chấp nhận vào Phase 1 / lùi Phase 2 / từ chối
Người quyết:    <ai>
```

**Không nhận yêu cầu qua tin nhắn rồi làm luôn.** Đây là cách một dự án 3 tháng biến thành 6 tháng mà không ai chỉ ra được lúc nào nó phình ra.

---

## Bộ sản phẩm cuối cùng của BA

| # | Tài liệu | Dùng để làm gì |
|---|---|---|
| 1 | `glossary.md` | Cả team nói cùng một ngôn ngữ |
| 2 | `05-data-profile.md` (PM+AI sinh, BA thẩm định) | Biết dữ liệu thật ra sao, không đoán |
| 3 | `sample-data/` | Dữ liệu test dùng chung cho dev và QA |
| 4 | `decision-log.md` | Ai quyết gì, khi nào — chống việc quay lại tranh cãi |
| 5 | `assumption-log.md` | Giả định nào chưa xác nhận, ai phải xác nhận |
| 6 | `flows/` | Dev hiểu luồng trước khi code |
| 7 | `state-machine.md` | Nền tảng cho thiết kế bảng dữ liệu |
| 8 | `decision-tables.md` | Lõi nghiệp vụ ở dạng test được ngay |
| 9 | `user-stories.md` | Backlog |
| 10 | `traceability-matrix.md` | Chứng minh không sót tiêu chí nghiệm thu nào |
| 11 | `scope-baseline-v1.md` | Mốc để so khi có thay đổi |

---

## Những lỗi BA hay mắc ở loại dự án này

| Lỗi | Hậu quả | Cách tránh |
|---|---|---|
| Chép lại brief thành user story | Mọi mơ hồ của brief đi thẳng vào code | Mỗi story phải trả lời được "làm sao QA biết cái này đạt?" |
| Bỏ qua ca lỗi | Đến UAT mới phát hiện, sửa gấp, chất lượng kém | Với mỗi luồng thuận, viết ít nhất 2 tiêu chí cho ca lỗi |
| Chấp nhận tiêu chí định tính | Cãi nhau lúc nghiệm thu | "Khác nhau hoàn toàn", "content hay", "nhanh" đều phải quy ra số |
| Không khảo sát dữ liệu thật | Thiết kế đúng lý thuyết, sai thực tế | Ngày 2–4 là bắt buộc, không rút gọn |
| Coi quyền API là việc của dev | Trễ 4–8 tuần, phát hiện muộn | BA phải theo dõi nhóm A hằng tuần cho tới khi duyệt xong |
| Nhận thay đổi qua chat | Scope phình mà không ai thấy | Mọi thay đổi đi qua biểu mẫu ở trên |

---

## Việc BA theo dõi hằng tuần (không dừng sau 2 tuần)

- Trạng thái Meta App Review và TikTok audit — **cập nhật mỗi tuần cho tới khi xong**. Đây là rủi ro số một của dự án.
- Các giả định trong `assumption-log.md` đã được xác nhận chưa.
- Story sắp vào sprint đã đạt Definition of Ready chưa.
- Có yêu cầu mới nào lọt vào ngoài quy trình không.
