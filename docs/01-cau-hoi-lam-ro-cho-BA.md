# Bộ câu hỏi làm rõ requirements — Công cụ đăng bài tự động

Dùng cho BA khi làm việc với stakeholder (chủ shop / vận hành / marketing / IT).

**Quy ước mức độ:**
- 🔴 **Chặn** — không có đáp án thì không code được phần liên quan, hoặc code sai chắc chắn phải làm lại.
- 🟡 **Ảnh hưởng** — có thể giả định tạm, nhưng sai thì phải sửa nhiều.
- 🟢 **Nên biết** — ảnh hưởng nhỏ, có default hợp lý.

Mỗi câu có **"Vì sao hỏi"** để BA không bị stakeholder gạt đi bằng "cứ làm như brief".

> **Cập nhật v2 (12/08/2026):**
> - **Nhóm A:** PM xác nhận app Facebook & TikTok **đã có sẵn**. Các câu A1–A5 đổi tính chất từ "hỏi có chưa" thành **checklist verify trên dashboard** — chụp màn hình làm bằng chứng, không nhận trả lời miệng. TikTok (A4–A6) chỉ phục vụ Phase 2 nhưng vẫn verify ngay để Phase 2 không có khoảng chết.
> - **Nhóm B:** phần lớn sẽ được đóng bằng khảo sát dữ liệu tự động (`05-data-profile.md`) — BA thẩm định kết quả thay vì tự khảo sát.
> - **F5 (SaaS): ĐÃ CHỐT** — chuẩn bị SaaS mức data model ngay phase này. Xem decision log.

---

## A. Quyền truy cập nền tảng — đổi thành checklist verify (v2)

> App đã tồn tại, nhưng **"có app" ≠ "đã pass review/audit với đủ quyền"**. Mọi câu dưới đây verify bằng ảnh chụp dashboard developers.facebook.com / developers.tiktok.com trong tuần 0. Nếu verify ra thiếu quyền, thời gian chờ duyệt quay lại thành critical path như bản v1.

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| A1 | Đã có **Facebook App** chưa? App ID? Đang ở chế độ Development hay Live? | 🔴 | App ở Development chỉ đăng được lên Page của chính admin. Muốn đăng lên Page khách hàng phải Live + qua App Review. |
| A2 | Đã qua **Business Verification** của Meta chưa? Có tài khoản Business Manager không? | 🔴 | Bắt buộc để xin quyền `pages_manage_posts`. Nếu chưa có, phải nộp giấy phép kinh doanh, mất 1–3 tuần. |
| A3 | Đã xin các quyền `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `pages_manage_engagement` chưa? Trạng thái? | 🔴 | Thiếu bất kỳ quyền nào là không đăng được đúng định dạng tương ứng (Reels cần thêm quyền riêng). |
| A4 | Đã có **TikTok Developer App** chưa? Đã bật product **Content Posting API** chưa? Đã bật **Direct Post** chưa? | 🔴 | Không bật Direct Post thì chỉ đẩy được video vào hộp nháp, người dùng vẫn phải mở app TikTok bấm đăng thủ công — phá vỡ mục tiêu #3 của brief. |
| A5 | **TikTok App đã qua audit chưa?** | 🔴 **Cao nhất** | TikTok quy định: *"All content posted by unaudited clients will be restricted to private viewing mode"*. Chưa audit thì mọi bài đăng lên TikTok đều **ở chế độ riêng tư (SELF_ONLY)**, không ai thấy. Toàn bộ giá trị của việc đăng TikTok bằng 0. Audit mất nhiều tuần và có thể trượt. |
| A6 | Nếu TikTok audit không đạt hoặc chưa kịp, phương án chấp nhận được là gì? (a) chỉ làm Facebook trước, (b) TikTok đẩy vào nháp rồi bấm tay, (c) hoãn dự án | 🔴 | Đây là quyết định kinh doanh, không phải quyết định kỹ thuật. Phải chốt trước khi bắt đầu code phần TikTok. |
| A7 | Danh sách chính xác các **Facebook Page** và **tài khoản TikTok** sẽ đăng? Ai là admin/owner của từng cái? | 🔴 | Cần owner thật để cấp quyền. Tài khoản TikTok cá nhân và Business có API khác nhau. |
| A8 | Ai giữ và chịu trách nhiệm về token/credential? Có quy trình khi nhân sự đó nghỉ việc không? | 🟡 | Token Facebook và TikTok đều có hạn (TikTok refresh token ~365 ngày). Không có người sở hữu thì hệ thống chết âm thầm. |

**Việc BA phải làm ngay, không chờ họp:** yêu cầu IT/stakeholder chụp màn hình trạng thái app trên developers.facebook.com và developers.tiktok.com. Trả lời miệng "chắc có rồi" không tính.

---

## B. Nguồn dữ liệu — Google Drive & Google Sheet

> **v2 — ĐÃ KHẢO SÁT XONG (12/08/2026):** các câu **B1, B2, B3, B4, B7, B8, B9, B10, B11 đã ĐÓNG** — đáp án chi tiết ở `05-data-profile.md` mục 6. Còn hỏi stakeholder: **B5, B6, B12, B13** + 9 câu hỏi MỚI phát sinh từ dữ liệu (`05-data-profile.md` mục 7 — trong đó nặng nhất: thư mục "Hàng Thiết Kế" không đọc được, và chỉ ~20 mã đủ điều kiện đăng ngay).
>
> Đáp án chốt nhanh: tồn theo **MÃ** không theo màu (B10) · cột Tồn luôn là **số hoặc trống** (B8) · Lưu ý chỉ có **3 giá trị**, thêm giá trị mới "Không cần cọc" chưa có rule (B9) · 28,2% file sai chuẩn tên (B2) · màu có dấu/không dấu lẫn lộn, cần bảng chuẩn hoá (B3).

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| B1 | Thư mục "Ảnh AI" hiện có **bao nhiêu file**, bao nhiêu mã sản phẩm? Có thư mục con không hay phẳng hết? | 🔴 | Drive API phân trang; thư mục phẳng 50k file cần chiến lược index khác hoàn toàn so với 2k file. Ảnh hưởng trực tiếp đến thời gian tải và thiết kế cache. |
| B2 | Quy ước đặt tên có **luôn luôn** đúng chuẩn `MÃ-Màu (số).ext` không? Xin **20 ví dụ thật**, bao gồm cả ca lạ. | 🔴 | Brief nói "sai chuẩn thì báo lỗi". Nhưng nếu 30% file sai chuẩn thì công cụ báo lỗi liên tục và vô dụng. Phải biết tỉ lệ thật. |
| B3 | Tên màu có thể có **nhiều từ** không (vd "Xanh rêu", "Đỏ đô")? Có dấu cách thừa, có viết hoa/thường lẫn lộn không? | 🔴 | Quyết định regex parse tên file. Sai là lọc màu sai toàn bộ. |
| B4 | Số trong ngoặc có **liên tục** không, có trùng không, có bắt đầu từ 1 không? Có file không có ngoặc không? | 🟡 | Ảnh hưởng logic "lấy 5–10 ảnh đầu theo số tăng dần". |
| B5 | Ai được quyền thêm/sửa/xoá file trong Drive? File có bị đổi tên sau khi đã đăng không? | 🟡 | Nếu file bị đổi tên/xoá giữa lúc hẹn lịch và lúc đăng, bài sẽ lỗi. Cần quyết định: fail hay bỏ qua. |
| B6 | Cho phép dùng **Service Account** đọc Drive/Sheet không, hay bắt buộc OAuth theo người dùng? | 🔴 | Service Account đơn giản hơn nhiều và không hết hạn. Nhưng cần IT chia sẻ thư mục + sheet cho email service account. Đây là quyết định của IT/security. |
| B7 | Sheet "Mẫu 2026" có **bao nhiêu dòng**? Tên cột **chính xác từng ký tự** là gì? (xin bản export CSV mẫu) | 🔴 | Brief ghi "Mã sản phẩm", "Tồn", "Lưu ý nhận sx 1c / sx hết tồn" — tên cột thật trong sheet có thể khác (viết tắt, xuống dòng, có dấu cách cuối). Code đọc sai cột là sai toàn bộ. |
| B8 | Cột **Tồn** luôn là **số** hay có khi là chữ ("còn ít", "hết", "-", ô trống)? | 🔴 | Quy tắc chặn ở mục 3 phụ thuộc hoàn toàn vào việc so sánh số. Gặp chữ thì xử lý sao — chặn cho an toàn, hay bỏ qua? |
| B9 | Cột **Lưu ý** có những giá trị nào trên thực tế? Xin danh sách giá trị duy nhất (distinct). | 🔴 | Brief chỉ nêu `"HẾT HÀNG"` và `"Không nhận sx 1c"`. Thực tế thường có 10–20 biến thể viết khác nhau. Phải liệt kê hết để viết rule. |
| B10 | **Tồn là tồn theo mã hay theo màu?** Sheet có tách tồn từng màu không? | 🔴 | Brief cho chọn màu và đăng từng màu một bài, nhưng tồn kho lại tra theo mã. Nếu mã còn 10 nhưng màu Tím đã hết, hệ thống vẫn đăng màu Tím → bán hàng không có. **Đây là lỗ hổng nghiệp vụ trong brief.** |
| B11 | Một mã có thể xuất hiện trên **nhiều dòng** trong sheet không (mỗi màu một dòng)? | 🟡 | Quyết định cách tra cứu: 1-1 hay 1-nhiều. |
| B12 | Sheet có bị người khác sửa cấu trúc (thêm/xoá/đổi thứ tự cột) không? Có ai chịu trách nhiệm giữ nguyên không? | 🟡 | Đọc theo tên cột thay vì vị trí cột sẽ chống được đổi thứ tự, nhưng không chống được đổi tên. Cần cam kết hoặc cần cơ chế cảnh báo schema drift. |
| B13 | Có nguồn tồn kho nào **chính xác hơn Sheet** không (phần mềm bán hàng, ERP, KiotViet/Sapo/Haravan)? | 🟡 | Nếu có, nên đọc từ đó cho bước "kiểm tra lại tồn ngay trước khi đăng" (mục 9). Sheet do người nhập tay luôn trễ và sai. |

---

## C. Logic chọn màu, chọn ảnh — brief còn mơ hồ

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| C1 | Mục 4.2: nhập **một số duy nhất** (vd `25`) → "các ảnh còn lại xếp sau theo số tăng dần". **"Còn lại" tính từ số 1, hay từ số 26 trở đi?** | 🔴 | Hai cách hiểu cho ra hai bộ ảnh hoàn toàn khác nhau. |
| C2 | Trường hợp C1: nếu ảnh `25` là số **lớn nhất**, "còn lại" lấy ở đâu? | 🔴 | Edge case chắc chắn xảy ra. |
| C3 | "Các ảnh còn lại" chỉ trong **màu đã chọn**, hay của cả mã (mọi màu)? | 🔴 | Ảnh hưởng chất lượng bài đăng — trộn màu vào một album là lỗi nghiệp vụ. |
| C4 | Mục 4.1: chọn **gộp nhiều màu vào một bài** — thứ tự ảnh sắp thế nào? Ảnh bìa là màu nào? Caption nhắc màu nào, hay nhắc tất cả? | 🔴 | Brief cho phép gộp nhưng không định nghĩa hành vi. |
| C5 | Nhập số đuôi nhưng chỉ **một phần** tồn tại (nhập `3,7,99`, ảnh 99 không có) → chặn cả bài, hay đăng 2 ảnh còn lại và cảnh báo? | 🔴 | Brief nói "báo lỗi, không tự bỏ qua im lặng" nhưng không nói có chặn hay không. |
| C6 | Facebook album tối đa bao nhiêu ảnh mà shop muốn? TikTok carousel giới hạn ảnh khác Facebook — khi lệch thì cắt bớt hay báo lỗi? | 🟡 | Hai nền tảng có giới hạn khác nhau; cần quy tắc thống nhất. |
| C7 | Ảnh có cần **resize/nén** trước khi đăng không? Có được phép chèn watermark/logo không? | 🟢 | Ảnh hưởng scope và thời gian xử lý. |

---

## D. AI sinh content — nhóm dễ tranh cãi khi nghiệm thu

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| D1 | **"Caption khác nhau hoàn toàn" đo bằng gì?** Cần một ngưỡng cụ thể (vd: không trùng quá 8 từ liên tiếp, độ tương đồng < 70%). | 🔴 | Đây là tiêu chí nghiệm thu ở mục 10 nhưng **không đo được**. Không định lượng thì lúc UAT sẽ cãi nhau vô tận. Đề xuất: chốt cả cách đo và ngưỡng ngay từ đầu. |
| D2 | Mục 7.5: "số nào **trông giống giá tiền**" — định nghĩa chính xác? | 🔴 | `750.000` là giá. Nhưng `size 38`, `100% cotton`, `set 2 món`, `dài 1.2m`, `mùa hè 2026` thì sao? Regex sai sẽ chặn nhầm caption hợp lệ, gây tắc nghẽn vận hành. Cần bộ ví dụ **được chặn** và **không được chặn**. |
| D3 | Nếu AI viết lại 3 lần vẫn không đạt validator, xử lý sao? Chặn hẳn, hay cho người sửa tay và bỏ qua? | 🔴 | Không có đường thoát thì công cụ sẽ treo. |
| D4 | Ai sở hữu và duyệt **file prompt mẫu** cho từng nền tảng? Ai được sửa? Có cần lịch sử phiên bản không? | 🟡 | Brief nói "chỉnh được mà không cần sửa code" — cần rõ ai chỉnh và có kiểm soát không, tránh một người sửa hỏng caption cả shop. |
| D5 | Có **danh sách từ cấm** không (cam kết chữa bệnh, "rẻ nhất", so sánh đối thủ, từ nhạy cảm với chính sách quảng cáo Meta)? | 🟡 | Vi phạm chính sách Meta có thể bị hạn chế Page. Nên có blacklist. |
| D6 | Hashtag: có bộ hashtag **cố định của thương hiệu** phải luôn có không? AI tự sinh hoàn toàn, hay cố định + AI bổ sung? | 🟡 | Ảnh hưởng thiết kế prompt và validator. |
| D7 | Ngân sách AI mỗi tháng khoảng bao nhiêu? Trung bình đăng bao nhiêu bài/ngày? | 🟡 | Mỗi bài = 1 lần gọi AI có kèm ảnh. 50 bài/ngày × 3 kênh = 150 lượt/ngày. Cần ước tính chi phí trước khi chốt model. |
| D8 | Caption có cần đúng **giọng thương hiệu** cụ thể không? Xin **10 caption mẫu do người viết** mà shop hài lòng. | 🔴 | Không có mẫu tham chiếu thì không thể tinh chỉnh prompt, và cũng không có căn cứ nghiệm thu "content hay". |
| D9 | AI viết sai thông tin sản phẩm và bài đã đăng — ai chịu trách nhiệm? Có bắt buộc người duyệt trước khi đăng không? | 🟡 | Brief để chế độ tự động đăng mặc định TẮT — cần xác nhận có được phép BẬT không, và ai quyết định. |

---

## E. Đăng bài, hẹn lịch, vận hành

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| E1 | Mục 6: "đăng giãn cách 1–3 phút" — giãn cách **giữa các kênh** của cùng một bài, hay **giữa các bài** trong lô? | 🔴 | Hai cách hiểu cho ra thời gian chạy lô rất khác nhau (lô 20 mã × 3 kênh có thể là 1 giờ hoặc 3 giờ). |
| E2 | Múi giờ hẹn lịch? Có đăng ngoài giờ hành chính, cuối tuần, ngày lễ không? | 🟡 | Ảnh hưởng scheduler và cấu hình server. |
| E3 | Mục 9: "hàng bán hết trong đêm thì tự động hủy bài và **báo người vận hành**" — báo **qua kênh nào**? (Zalo, Slack, email, chỉ hiện trên màn hình?) Báo cho **ai**? | 🔴 | "Báo trên màn hình" lúc 3h sáng thì không ai thấy. Cần kênh thông báo thật, nếu không tính năng này vô nghĩa. |
| E4 | Đăng lỗi thì có **tự thử lại** không? Bao nhiêu lần, cách nhau bao lâu? | 🔴 | Không có quy tắc rõ dễ dẫn đến **đăng trùng bài** — lỗi tệ nhất với công cụ đăng bài. |
| E5 | Có cần **xoá/sửa bài đã đăng lên nền tảng** từ công cụ không? | 🟡 | Brief không nhắc. Nếu có thì là một epic riêng đáng kể. |
| E6 | Có cần chặn **đăng trùng** (cùng mã, cùng màu, cùng kênh trong X ngày) không? | 🟡 | Brief không nhắc, nhưng vận hành thực tế gần như chắc chắn cần. |
| E7 | Có cần **báo cáo hiệu quả** (lượt xem, tương tác) không? | 🟢 | Nếu có thì cần thêm quyền đọc insights và một epic riêng. Nên tách khỏi phase 1. |
| E8 | Lưu log bao lâu? Có yêu cầu truy vết "ai đăng bài nào lúc nào" không? | 🟢 | Ảnh hưởng thiết kế audit log. |

---

## F. Người dùng, phạm vi, vận hành hệ thống

| # | Câu hỏi | Mức | Vì sao hỏi |
|---|---|---|---|
| F1 | Bao nhiêu người dùng? Có cần **phân quyền** không (ai được đăng, ai chỉ được soạn, ai quản lý kênh)? | 🔴 | Ảnh hưởng data model ngay từ đầu. Thêm phân quyền sau tốn gấp nhiều lần. |
| F2 | Đăng nhập bằng gì? Có tài khoản Google Workspace công ty không? | 🟡 | Đã dùng Google Drive/Sheet thì đăng nhập Google là rẻ nhất và an toàn nhất. |
| F3 | Dùng trên **máy tính hay điện thoại**? Brief mục 8 nhắc "chọn ảnh/video từ máy tính, điện thoại". | 🔴 | Nếu bắt buộc dùng tốt trên điện thoại thì khối lượng UI tăng đáng kể (kéo-thả sắp xếp trên mobile là việc khó). |
| F4 | Triển khai ở đâu — server công ty, VPS thuê, hay cloud? Có ràng buộc dữ liệu phải ở VN không? | 🟡 | Ảnh hưởng lựa chọn hạ tầng và chi phí. |
| F5 | ~~Sau này có bán ra ngoài dạng SaaS không?~~ **ĐÃ CHỐT 12/08/2026: có, chuẩn bị mức data model ngay phase này** (tenant_id mọi bảng + config theo tenant; chưa làm UI đăng ký/mời user) | ✅ | Người quyết: PM/owner. Chi tiết trong `02-dinh-huong-cong-nghe.md` mục 4. |
| F6 | Yêu cầu về thời gian hoạt động, sao lưu, khôi phục? Ai vận hành sau khi bàn giao? | 🟡 | Ảnh hưởng scope của phần vận hành. |
| F7 | **Deadline mong muốn** và mức độ cứng của nó? | 🔴 | Deadline cứng + phụ thuộc audit TikTok = phải cắt scope. Phải nói ra sớm. |

---

## G. Giả định tạm thời (nếu chưa có đáp án, làm theo các mốc này và ghi vào Assumption Log)

| Chủ đề | Giả định | Sẽ phải sửa nếu... |
|---|---|---|
| Người dùng | Nội bộ, 5–20 người, không phân quyền phức tạp | F1 trả lời cần phân quyền |
| Đăng nhập | Google Workspace, giới hạn theo tên miền công ty | F2 không có Workspace |
| Truy cập Drive/Sheet | Service Account, được chia sẻ quyền đọc | B6 bị security từ chối |
| Tồn kho | Tồn theo mã (không theo màu), so sánh số nguyên | B10 xác nhận có tồn theo màu |
| Ô Tồn không phải số | Coi như **hết hàng, chặn đăng** (an toàn hơn) | B8 yêu cầu ngược lại |
| Giãn cách | Giữa các **kênh** của cùng một bài | E1 xác nhận khác |
| Thử lại khi lỗi | Tối đa 2 lần, cách nhau 60s, có khoá chống trùng | E4 xác nhận khác |
| Caption khác nhau | Không trùng quá 8 từ liên tiếp giữa 2 kênh bất kỳ | D1 chốt ngưỡng khác |
| Thiết bị | Ưu tiên desktop; mobile chỉ xem và duyệt caption | F3 yêu cầu mobile đầy đủ |
| ~~Đa khách hàng~~ | ~~giả định~~ → **đã thành quyết định chính thức** (F5 chốt 12/08/2026) | — |

---

## H. Khảo sát dữ liệu — v2: PM + AI agent tự làm, BA thẩm định kết quả

> **v2:** 4 việc dưới đây không giao cho BA nữa. PM + AI agent query trực tiếp Drive/Sheet (qua Google Drive MCP), xuất kết quả ra `05-data-profile.md`. Việc của BA: **đọc và thẩm định** báo cáo đó, đối chiếu với hiểu biết nghiệp vụ, và mang các bất thường vào workshop.

Những thứ dưới đây stakeholder sẽ không trả lời được, BA phải tự đi lấy dữ liệu thật:

1. **Tải toàn bộ danh sách tên file** trên Drive → thống kê: bao nhiêu file, bao nhiêu mã, bao nhiêu file sai chuẩn, danh sách màu duy nhất, phân bố số ảnh mỗi mã.
2. **Export Sheet ra CSV** → thống kê: tên cột chính xác, số dòng, tỉ lệ ô trống, distinct của cột *Tồn* và cột *Lưu ý*, số mã có trên Sheet nhưng không có ảnh và ngược lại.
3. **Đối chiếu chéo**: bao nhiêu mã có ảnh nhưng không có trên Sheet (sẽ không đăng được), bao nhiêu mã trên Sheet mà cột *Mô tả sản phẩm* trống (AI không có nguyên liệu viết).
4. **Lấy 5 mã đại diện** phủ các ca: 1 mã nhiều màu, 1 mã 1 màu, 1 mã có video, 1 mã hết hàng, 1 mã tồn ≤ 3 — dùng làm bộ dữ liệu test xuyên suốt dự án.

Kết quả 4 việc này quan trọng hơn cả buổi họp làm rõ. Nhiều câu ở nhóm B sẽ tự có đáp án.
