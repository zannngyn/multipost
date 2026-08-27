# PROMPT — Màn chúc mừng + bàn giao mượt vào app (onboarding)

> **TRẠNG THÁI: ĐÃ DỰNG XONG** (27/08/2026, branch `feat/onboarding-celebrate-handoff`).
> Ba chỗ trong bản kế hoạch dưới đây **đã bị thay đổi khi thực thi**, vì thực tế bác bỏ
> chúng. Chúng được sửa tại chỗ và ghi lý do; xem thêm mục 11 ở cuối.

> **Giao cho:** agent `ui-web` (domain E10, model Opus 5).
> **Gate:** `reviewer-qa` phải trả PASS (review diff + dán output lệnh verify thật) trước khi
> báo xong. Không ngoại lệ.
> **Worktree:** `.claude/worktrees/e10-onboarding-motion`, branch cắt từ `dev`.

---

## 0. Đọc trước khi gõ dòng code đầu tiên

**Skill (SKILL-MAP.md — đọc `core-` trước, `web-` sau, KHÔNG lấy bản `mobile-`):**

| Vì sao cần | core | web |
|---|---|---|
| Nhóm 1, luôn kèm | `core-component-reuse` | `web-component-reuse` |
| Nhóm 1, luôn kèm | `core-accessibility` | `web-accessibility` |
| Nhóm 1, luôn kèm | `core-feedback-states` | `web-feedback-states` |
| Nhóm 1, luôn kèm | `core-design-tokens` | `web-design-tokens` |
| Toàn bộ phần chuyển động + bàn giao | `core-motion` | `web-motion` |
| Màn cuối của luồng nhiều bước | `core-wizard` | `web-wizard` |

**File phải đọc hết trước khi sửa** (không đọc lướt — mỗi file có đoạn comment ghi lại một
cái bẫy đã dính thật, và task này đi qua đúng các bẫy đó):

- `src/ui/components/onboarding/flow/OnboardingFlow.tsx` — máy trạng thái, `runAttempt`,
  effect thoát khi `completedAt` khác null.
- `src/ui/components/onboarding/flow/OnboardingFrame.tsx` — `AnimatePresence mode="wait"`,
  `SCREEN_VARIANTS`, `ScreenLayer` (focus + `inert`).
- `src/ui/components/onboarding/flow/onboarding-motion.css` — **bắt buộc đọc cả comment**,
  đặc biệt đoạn về animation origin, `[data-astryx-theme]` và `light-dark()`.
- `src/ui/components/onboarding/flow/onboarding-motion.ts` — bảng delay, `enterDelay`,
  `enterIndex`, `LAST_STAGGERED_INDEX`.
- `src/ui/components/onboarding/flow/StepActions.tsx` — mẫu "entrance ở wrapper, state ở
  element con", mẫu one-shot animation không phụ thuộc `animationend`.
- `src/ui/components/onboarding/flow/WelcomeScreen.tsx` — màn không có card, cách nó chọn
  slot delay.
- `src/ui/components/onboarding/setup-steps.ts` + `first-run.types.ts` + `SetupDock.tsx` —
  6 bước thiết lập, `SETUP_STEP_PRESENTATION`, `buildStepViews`, kiểu `StepView`.
- `src/ui/hooks/useSetupProgress.ts`, `src/ui/services/setup-progress.api.ts` — `setupKeys`.
- `src/app/(app)/layout.tsx`, `src/ui/components/shell/AppFrame.tsx` — phía nhận bàn giao.
- `src/ui/hooks/useSetupDockState.ts` + `flow/usePassedSlides.ts` — **khuôn store**
  `useSyncExternalStore` của repo. Cờ bàn giao ở mục 5.3 chép đúng khuôn này.

---

## 1. Vấn đề đang có

Hôm nay, khi người dùng bấm "Tiếp tục" ở bước 4 (`channels`):

1. `runAttempt` lưu đáp án → `nextScreen("channels") === "done"` → `await finish.mutateAsync()`.
2. `useCompleteOnboarding.onSuccess` ghi `completedAt` vào cache React Query.
3. Effect `isFinished` trong `OnboardingFlow` thấy `completedAt !== null` → `router.replace("/")`.
4. Cắt cụp sang `/`. `OverviewScreen` mount với cache lạnh → một màn đầy skeleton. `SetupDock`
   trượt lên ở góc phải như thể vừa có ai đó gọi nó.

Người dùng vừa trả lời 4 câu hỏi và **không nhận được lời nào xác nhận là đã xong**. Cú
chuyển là một cú cắt cứng từ màn hình sạch sang màn hình đang tải. Đây là chỗ thiếu.

**Cần thêm hai thứ, và chúng là hai thứ khác nhau:**

- **A. Một màn chúc mừng** — đóng lại luồng khảo sát, nói rõ "xong rồi", và chỉ sang việc
  tiếp theo.
- **B. Một cú bàn giao mượt** — từ màn chúc mừng vào app, không cắt, không nháy, và app đã
  ấm sẵn khi tới nơi.

---

## 2. Kiến trúc — quyết định đã chốt, làm đúng như vậy

### 2.1. `celebrate` là một STAGE, không phải một SCREEN trong URL

`onboarding-steps.ts` là module thuần, đã có test, và `resolveScreen` là nguồn chân lý về
"đang ở câu hỏi nào". **KHÔNG được thêm `"celebrate"` vào `ONBOARDING_SCREENS`** — làm vậy
sẽ đổi hành vi của `screenStep`, `nextScreen`, `previousScreen` và `isOnboardingScreen`
cùng lúc, và `?step=celebrate` gõ tay lập tức thành hợp lệ.

Thay vào đó, thêm vào `onboarding-steps.ts`:

```ts
/** Màn chúc mừng. KHÔNG nằm trong URL: `?step=` chỉ mô tả câu hỏi, và màn này
 *  không phải câu hỏi. `OnboardingFlow` bật nó bằng latch cục bộ. */
export type OnboardingStage = OnboardingScreen | "celebrate";
```

- `OnboardingFrame` đổi prop `screen: OnboardingScreen` → `stage: OnboardingStage`. Đây là
  key của `AnimatePresence`, nên đổi stage tự động chạy đúng cú trượt ngang sẵn có
  (`direction = 1`, vào từ bên phải).
- `StepDots` nhận `stage`. Ở `celebrate`: **cả 4 chấm đều đầy** (`bg-foreground`), sr-only
  đổi thành `Hoàn tất 4/4 bước`. Không sửa `screenStep` — thêm một nhánh sớm trong
  `StepDots`.
- `ScreenLayer` `data-onboarding-screen={stage}` — giữ nguyên, chỉ nới kiểu.
- **Nút Back ở `celebrate` phải là `undefined`.** Khảo sát đã đóng; quay lại một câu hỏi đã
  trả lời sau khi `completed_at` đã ghi là ngõ cụt. Truyền `onBack={undefined}` giống
  `welcome`.
- Không có `router.push` nào cho stage này ⇒ không có entry lịch sử ⇒ nút Back của trình
  duyệt đưa họ về `?step=channels`, mà lúc đó latch đã bật và effect thoát đã bị chặn. Xử
  lý: xem 2.3.

### 2.2. Thứ tự mới của `runAttempt`

```
lưu đáp án channels → finish.mutateAsync() thành công → BẬT latch celebrate
   → render màn chúc mừng → (người dùng bấm | hết giờ chờ) → bàn giao → router.replace("/")
```

`finish` vẫn chạy **ngay ở bước 4**, không dời sang nút của màn chúc mừng. Lý do: nếu dời,
một người đóng tab ở màn chúc mừng sẽ chưa có `completed_at`, và lần vào sau bị hỏi lại câu
4. `completed_at` phải được ghi ngay khi người dùng đã trả lời xong câu cuối.

Nếu `finish` **thất bại**: không có màn chúc mừng, giữ nguyên hành vi hôm nay (ở lại bước 4,
`ApiErrorNotice` + "Thử lại"). Latch phải được gỡ trong nhánh `catch`.

### 2.3. ⚠️ CÁI BẪY LỚN NHẤT CỦA TASK NÀY — và cách né hẳn nó

**Bản kế hoạch ban đầu sai ở đây, và bản đã dựng làm khác.** Giữ lại cả hai vì cái bẫy là
thật; chỉ có cách chữa là đổi.

**Cái bẫy.** `finish.mutateAsync()` gọi `onSuccess` **bên trong** lời await, và `onSuccess`
ghi `completedAt` vào cache. Cú ghi đó gây một lần render **trước khi** dòng lệnh sau
`await` của bạn chạy. Nên một latch dựng sau await là dựng muộn một lần render: effect
thoát đã thấy hồ sơ đã đóng, không thấy gì để ăn mừng, và đã điều hướng đi. Không lỗi,
không log, chỉ thỉnh thoảng trên máy nhanh.

**Cách chữa ban đầu — `useRef` dựng đồng bộ trước await — KHÔNG DÙNG ĐƯỢC.** Hai lý do:

1. `react-hooks/refs` của repo cấm đọc ref trong lúc render, và quyết định vẽ gì thì bắt
   buộc phải đọc trong lúc render. Lint đỏ, và nó đỏ đúng.
2. Kể cả nếu lách được, nó vẫn là một cờ phải dựng đúng một khoảnh khắc — tức là vẫn còn
   cửa sổ để lỡ, chỉ hẹp hơn.

**Cách đã dựng: hai ảnh chụp của cùng một trường, không có cờ nào cả.**

```ts
const [completedAtOnArrival, setCompletedAtOnArrival] = useState<string | null | undefined>(
  undefined,
);
if (completedAtOnArrival === undefined && profile !== undefined) {
  setCompletedAtOnArrival(profile.completedAt);   // chỉnh state trong lúc render
}
```

"Vừa hoàn tất" = `completedAt` **lúc mới vào** là `null`, còn **bây giờ** thì không. Cả hai
đến từ cùng một query, nên không có thứ tự nào phải đúng để phép so sánh này đúng — cửa sổ
race biến mất chứ không thu hẹp lại. Chỉnh state trong lúc render là khuôn React hỗ trợ
cho "state suy ra từ prop vừa đổi", và `direction` ngay bên dưới cùng `StepActions` đã dùng
đúng khuôn đó từ trước.

Kiểm bằng trình duyệt: tenant hoàn tất từ tuần trước gõ `/onboarding` đi thẳng vào app,
không màn chúc mừng (kịch bản S7).

### 2.4. Tách logic ra hàm thuần để test được

vitest chạy `environment: "node"`, repo **cố ý không có jsdom**. Nên mọi quyết định phải
nằm trong hàm thuần, đặt ở `src/ui/components/onboarding/flow/celebrate-stage.ts`:

```ts
export interface CelebrateDecisionInput {
  readonly completedAt: string | null;                      // ngay lúc này
  readonly completedAtOnArrival: string | null | undefined; // lúc màn hình mở
  readonly hasHandedOff: boolean;                           // đã bắt đầu đi chưa
}
export type CelebrateDecision = "flow" | "celebrate" | "leave";
export function decideCelebrate(input: CelebrateDecisionInput): CelebrateDecision;
```

Bảng chân trị phải có test cho **cả 12 tổ hợp** (2 × 3 × 2), kể cả các tổ hợp không thể xảy
ra trong thực tế — chúng là thứ xuất hiện khi một lần sửa sau làm lệch thời điểm chụp.

---

## 3. Màn chúc mừng — nội dung và bố cục

Dùng lại `OnboardingFrame` (nó lo top bar, focus, `inert`, trượt ngang). File mới:
`src/ui/components/onboarding/flow/CelebrateScreen.tsx`. Component **thuần**: nhận props,
không router, không hook fetch — để render được dưới `renderToStaticMarkup`.

```tsx
export function CelebrateScreen({
  name,                 // string | null, cùng nguồn với WelcomeScreen
  nextSteps,            // readonly StepView[] (kiểu ở ./first-run.types) — 3 bước chưa xong
  secondsLeft,          // number | null — null = đã tắt đếm ngược
  onEnter,              // () => void
  onCancelCountdown,    // () => void
}: CelebrateScreenProps)
```

### 3.1. Chữ (tiếng Việt, giọng giống phần còn lại của luồng)

- `<h1>` hai dòng, cùng cỡ chữ với `WelcomeScreen` (`text-[1.75rem] leading-[2.1875rem]
  font-medium`, `font-heading`, `text-balance`, `tabIndex={-1}`):
  - dòng 1: `Xong rồi 🎉` — nếu có tên: `Xong rồi, {name} 🎉`
  - dòng 2: `MYSP đã hiểu xưởng của bạn`
- Câu phụ, `text-muted-foreground text-sm text-center max-w-[34rem]`:
  `Câu trả lời của bạn đã được lưu. Từ giờ MYSP sẽ gợi ý caption và kênh đăng theo đúng
  mặt hàng bạn bán.`
- Nhãn nhóm việc tiếp theo, dùng `Eyebrow` sẵn có (`src/ui/components/ui/eyebrow.tsx`):
  `CÒN {n} BƯỚC ĐỂ ĐĂNG BÀI ĐẦU TIÊN`
- Nút chính: `Vào MYSP` + `ArrowRight`. Cùng khuôn với nút của `WelcomeScreen`:
  `h-12 gap-2 rounded-lg px-6 text-sm font-medium bg-foreground text-background
  hover:bg-foreground/90`. Ôm chữ, không `w-full`.

**KHÔNG viết lại chữ của 6 bước thiết lập.** Lấy từ `SETUP_STEP_PRESENTATION` /
`buildStepViews(progress)` — cùng `title`, `description`, `minutes`, `href` mà `SetupDock`
đang dùng. Đây là điểm mấu chốt của "mượt": danh sách người dùng thấy ở màn chúc mừng
**đúng bằng** danh sách cái dock trong app sẽ chỉ cho họ ngay sau đó. Một chữ khác nhau là
một thứ phải viết lại hai lần và là một cơ hội để hai bên lệch nhau.

Lấy tối đa **3** bước chưa xong đầu tiên. Nếu `useSetupProgress` chưa có dữ liệu hoặc lỗi:
**không hiện khối này**, không hiện skeleton, không hiện lỗi — màn chúc mừng vẫn đủ nghĩa
khi thiếu nó, và một thông báo lỗi trên màn ăn mừng là thứ tệ nhất có thể xảy ra ở đây.
Nút "Vào MYSP" không bao giờ phụ thuộc vào query này.

### 3.2. Con dấu (seal)

Một vòng tròn `size-16`, nền `bg-foreground`, icon `Check` `text-background`
(**khai màu tường minh** — Astryx `<Theme>` scope `--color-text-primary` xuống, chữ/icon
không khai màu trên nền tối sẽ tàng hình; đã dính thật ở `SetupDock` và `WizardRail`).

Sau nó một quầng (`halo`): `absolute inset-0 rounded-full border border-foreground/20`,
`aria-hidden`, nở một lần rồi tắt. **Một lần, không lặp** — không có gì trên màn này được
phép chuyển động vĩnh viễn.

### 3.3. Nền — ĐÃ THỬ "đóng khung hai đầu" VÀ BỎ

Ý ban đầu: cho `GridBackdrop` (hiện chỉ vẽ ở `welcome`) quay lại ở `celebrate`, để nền kẻ
mở luồng ở màn chào và đóng luồng ở màn chúc mừng.

**Dựng rồi, chụp màn hình, và bỏ.** `GridBackdrop` chừa một khoảng trống vừa đúng nội dung
của màn chào — hai dòng chữ và một nút. Màn chúc mừng cao gấp ba (con dấu, tiêu đề, câu
phụ, ba dòng việc, nút). Đo ở 1400×900: dòng việc thứ ba đè lên mark TikTok ở (568, 622),
và mark Facebook nằm ngang hàng với danh sách.

Luật mà các ảnh tham chiếu vẫn nói vì vậy hoá ra là về **KHỐI LƯỢNG NỘI DUNG**, không phải
về vị trí trong luồng: màn nào mang tiêu đề + danh sách + nút thì đứng trên vải trơn. Màn
chúc mừng theo luật đó, giống bốn câu hỏi.

Ghi chú lý do đã nằm sẵn ngay cạnh nhánh backdrop trong `OnboardingFrame.tsx`.

### 3.4. KHÔNG dùng confetti

`canvas-confetti` bị `motion-import-sweep.test.ts` liệt kê nhưng **không có trong
package.json** — thêm nó là thêm dependency, mà CLAUDE.md cấm thêm dependency khi chưa hỏi.
Ngoài ra một mưa hạt là chuyển động lặp, decorative, và trái với hợp đồng "thứ đã yên thì
đứng yên" mà `OverviewScreen` và `SetupDock` đang giữ. Con dấu + quầng nở là đủ.

---

## 4. Chuyển động — áp dụng đúng những gì đã học

### 4.1. Cùng một timeline, không phải timeline riêng

Thêm vào `onboarding-motion.ts` (nơi duy nhất giữ đồng hồ):

```ts
/** Con dấu và quầng của màn chúc mừng. Trước cả tiêu đề: nó là thứ nói "xong". */
export const ENTER_DELAY_SEAL = "60ms";
/** Câu phụ dưới tiêu đề. */
export const ENTER_DELAY_SUBHEAD = "180ms";
/** Nút "Vào MYSP": một nhịp sau hàng việc thứ ba. Ba hàng, không phải sáu card,
 *  nên không dùng ENTER_DELAY_CTA (635ms — chỗ đó là hàng chờ không tồn tại). */
export const ENTER_DELAY_CELEBRATE_CTA = "calc(260ms + 3 * var(--stagger))";
```

Bảng thời gian phải khớp và phải **kết thúc dưới 1.2s** (tiêu chí nghiệm thu có sẵn của
luồng này):

| Phần tử | delay | duration | kết thúc |
|---|---|---|---|
| back + brand (đã có) | 0ms | 400ms | 400ms |
| chấm bước (đã có) | 80ms | 400ms | 480ms |
| nút sáng/tối (đã có) | 120ms | 400ms | 520ms |
| **con dấu + quầng** | 60ms | 525ms | 585ms |
| tiêu đề | 100ms | 525ms | 625ms |
| câu phụ | 180ms | 400ms | 580ms |
| hàng việc 1..3 | 260ms + n×62.5ms | 525ms | 910ms |
| nút "Vào MYSP" | 447.5ms | 525ms | 972.5ms |

Ba hàng việc dùng `enterIndex(0..2)` — trong ngưỡng `LAST_STAGGERED_INDEX` sẵn có.

### 4.2. Bốn luật của file CSS này, vi phạm là FAIL

1. **Entrance nằm trên WRAPPER, state nằm trên element con.** Một element vừa mang
   `.onboarding-enter` vừa mang `opacity-*` / `scale-*` (kể cả biến thể
   `disabled:opacity-50`) là mất state, im lặng: giá trị từ animation origin thắng mọi khai
   báo của author suốt thời gian animation chạy, và `animation-fill-mode` **không cứu
   được** — `backwards` chỉ nhả property sau khi animation kết thúc. Đã đo thật: 5 card mờ
   dần lên opacity 1 rồi mới tụt về 0.45, lệch pha, kéo dài ~1.1s. Guard trong
   `onboarding-motion.test.ts` + `option-card-render.test.tsx` phải bao được file mới.
2. **Hai họ property.** Keyframe animate `transform` + `opacity`. State (hover, press, dim)
   dùng `translate` / `scale` / `opacity` rời. Chúng compose thay vì đè nhau.
3. **Mọi khai báo có chuyển động nằm trong `@media (prefers-reduced-motion: no-preference)`.**
   Không phải "chậm lại" dưới `reduce` — **vắng mặt**. Không declare animation, không
   declare transition, để `getAnimations()` trả về rỗng và màn hình dùng được ngay khung
   hình đầu.
4. **Alias duration khai trên `[data-astryx-theme]`, KHÔNG phải `:root`.** `:root` sẽ resolve
   theo thang chậm của `@astryxdesign/core` (`--duration-slow-min: 730ms` thay vì 525ms) và
   mọi con số trong bảng trên sẽ sai mà không có gì báo. `--dur-*`, `--stagger`,
   `--ease-spring` đã có sẵn ở đó — dùng lại, đừng khai lại.

Thêm hai luật nữa cho task này:

5. **Không `light-dark()`.** `<Theme>` của Astryx đặt `color-scheme: light dark` nên
   `light-dark()` bám theo hệ điều hành chứ không theo class `.dark` của app. Nếu cần màu
   đổi theo theme: override bằng `.dark [data-astryx-theme]`, giống khối `--well-*`.
6. **Không có gì load-bearing treo vào `animationend`.** Tab nền không bắn event đó. Mọi
   thứ quyết định "khi nào đi tiếp" phải là `setTimeout` có cleanup.

### 4.3. Keyframe mới

```css
@keyframes onboarding-seal-in {   /* dùng --ease-spring, đỉnh ≤ 1.15 */
  from { opacity: 0; transform: scale(0.6); }
  60%  { transform: scale(1.08); }
  to   { opacity: 1; transform: none; }
}
@keyframes onboarding-halo-out {  /* một lần, rồi biến mất */
  from { opacity: .55; transform: scale(.7); }
  to   { opacity: 0;   transform: scale(1.6); }
}
```

`--ease-spring` hiện đang được ghi chú là "chỉ dùng cho selection feedback". Task này mở
rộng nó sang con dấu — **cập nhật đúng đoạn comment đó** thay vì lặng lẽ dùng thêm một chỗ.
Gate `impeccable` đã được PM cho phép spring easing ở phản hồi chọn (commit `64fc5b1`);
nếu nó chặn ở đây, báo orchestrator, đừng tự nới rule.

`animation-fill-mode`: `backwards`, không bao giờ `both`. Với `onboarding-halo-out`, trạng
thái nghỉ là "biến mất" nên phần tử phải bị **gỡ khỏi DOM** sau khi chạy (bằng `setTimeout`,
xem luật 6) hoặc để nó `opacity: 0` từ một rule tĩnh **ngoài** query `no-preference`… KHÔNG:
rule tĩnh `opacity: 0` sẽ làm quầng tàng hình luôn dưới `reduce`, mà dưới `reduce` quầng
đơn giản là không nên tồn tại. Cách đúng: chỉ render phần tử quầng khi
`useReducedMotion() !== true`, và gỡ nó bằng timer.

---

## 5. Bàn giao vào app — phần "load mượt"

### 5.1. Đếm ngược, và tại sao nó phải huỷ được

Màn chúc mừng tự chuyển sau `CELEBRATE_DWELL_MS = 4_000` (đo từ lúc mount, tức khoảng 3s
sau khi entrance kết thúc).

- Nút "Vào MYSP" luôn là đường đi chính và luôn bấm được ngay từ khung hình đầu.
- Đếm ngược hiện **thành chữ**, trong cùng vùng `role="status"`:
  `Tự động vào sau {secondsLeft}s`. Không có vòng tròn chạy quanh nút — đó lại là một
  chuyển động lặp.
- **Tương tác của NGƯỜI huỷ đếm ngược vĩnh viễn**: `keydown` và `pointerdown`.
  **KHÔNG bắt `focus`** — bản kế hoạch ban đầu có, và nó sai: `ScreenLayer` tự đưa focus vào
  thẻ `<h1>` ngay khi màn này mount, nên handler focus sẽ nổ ở mọi lần, cho mọi người, và
  đếm ngược sẽ không bao giờ chạy. Bấm phím và bấm chuột thì chỉ con người mới làm.
  Sau khi huỷ, dòng chữ biến mất và nút là đường duy nhất. Lý do là WCAG
  2.2.1: một màn tự biến mất mà người dùng không dừng được là lỗi a11y, và người đọc chậm
  là đúng nhóm người cần màn này nhất.
- `prefers-reduced-motion: reduce` → **không khởi động timer**. Màn đứng yên chờ bấm.
- Timer phải `clearTimeout` trong cleanup của effect. Một timer sống sót sau unmount sẽ gọi
  `router.replace` trên component đã chết.

`PENDING(celebrate-autoadvance)`: PM chưa chốt 4s hay bỏ hẳn tự động. Dùng 4s + huỷ được,
đánh dấu `// PENDING(celebrate-autoadvance)` tại hằng số.

### 5.2. Làm ấm app TRONG lúc chúc mừng

`QueryClientProvider` nằm ở `src/app/providers.tsx`, tức root layout — cache **sống xuyên**
`router.replace("/")` (điều hướng phía client, cây React phía trên không unmount). Nên
prefetch ở đây là thật, không phải trang trí.

Ngay khi màn chúc mừng mount:

```ts
router.prefetch("/");                       // RSC payload của trang tổng quan
queryClient.prefetchQuery({                 // dữ liệu của SetupDock
  queryKey: setupKeys.progress(tenantKey),
  queryFn: ({ signal }) => fetchSetupProgress(signal),
  staleTime: 30_000,
});
```

Giới hạn **đúng hai** thứ này. Không prefetch toàn bộ 5 query của `OverviewScreen` — chúng
là 5 request trên một màn mà người dùng đang đọc chữ, và các màn đó tự có trạng thái chờ
của mình.

**Prefetch hỏng phải im lặng.** `.catch(() => {})` là ngoại lệ duy nhất của luật "cấm nuốt
lỗi" trong task này, và nó phải có comment nói rõ vì sao: đây là tối ưu, không phải dữ liệu
màn hình; màn đích tự báo lỗi của nó. Ghi `console.debug` kèm `tenant_id` thay vì nuốt
hoàn toàn.

### 5.3. Cú chuyển hình — hai nửa, không nửa nào có thể kẹt

Không dùng lớp phủ (veil) toàn màn. Một veil mà lệnh gỡ không chạy (tab nền, animation
không bắn event) sẽ khoá cả app lại — rủi ro không đáng đổi.

Nền của `(onboarding)` và của `(app)` **cùng là `--background`**. Nên chỉ cần làm mờ hai
đầu nội dung, cái đường nối sẽ vô hình:

**Nửa A — phía onboarding rời đi.** Khi quyết định đi (bấm nút hoặc hết giờ):

1. `setIsLeaving(true)` → layer nhận class `.onboarding-handoff-out`
   (`opacity: 1 → 0`, `transform: scale(1) → scale(.98)`, `--dur-exit` = `--duration-medium`
   = 300ms, `--ease-standard`, `forwards`).
2. Gọi `markHandoffArrival()` (xem nửa B).
3. `setTimeout(() => router.replace("/"), 300)` — **timer, không phải `onAnimationEnd`**.
4. Dưới `reduce`: bỏ qua bước 1 và gọi `router.replace("/")` ngay.
5. Trong lúc rời đi, layer phải `inert` + `aria-hidden` để không ai bấm nút hai lần. Latch
   `hasHandedOff` chặn lần gọi thứ hai kể cả khi cả nút lẫn timer cùng bắn.

**Nửa B — phía app đi tới.** Class fade phải có mặt **ngay khung hình đầu tiên mà `AppFrame`
vẽ**, nếu không app sẽ nháy một khung hình đủ nét rồi mới mờ vào — tức là phải đọc **trong
lúc render**, không phải trong `useEffect`.

Cờ bàn giao là một **store module-scope phía client**, KHÔNG phải cookie và KHÔNG phải
`sessionStorage`. `router.replace("/")` là điều hướng phía client: module registry không
nạp lại, nên một biến ở phạm vi module sống xuyên qua cú chuyển route.

Dùng đúng khuôn `useSyncExternalStore` mà repo đã có hai bản —
`src/ui/hooks/useSetupDockState.ts` và `flow/usePassedSlides.ts`. File mới:
`src/ui/hooks/useHandoffArrival.ts`.

```ts
let isArriving = false;                     // module scope: sống qua router.replace
const listeners = new Set<() => void>();

/** Onboarding gọi ngay trước router.replace("/"). */
export function markHandoffArrival(): void {
  isArriving = true;
  for (const l of listeners) l();
}

/** AppFrame đọc TRONG LÚC RENDER. `getServerSnapshot` trả false: một lần tải
 *  trang thật thì không có bàn giao nào, nên không có hydration mismatch. */
export function useHandoffArrival(): boolean {
  return useSyncExternalStore(subscribe, () => isArriving, () => false);
}

/** Tiêu thụ cờ sau khi đã mount, để lần sau quay lại "/" không phát lại. */
export function consumeHandoffArrival(): void { isArriving = false; }
```

1. Phía onboarding gọi `markHandoffArrival()` ngay trước `router.replace("/")`.
2. `AppFrame` (đã là `"use client"`) đọc `useHandoffArrival()` và đặt class
   `.app-handoff-in` lên element ngoài cùng: `opacity: 0 → 1` + `translateY(6px) → 0`,
   400ms, `--ease-standard`, `backwards`. Khai trong file mới
   `src/ui/components/shell/handoff-motion.css`, **CSS thuần** — `motion-import-sweep.test.ts`
   cấm `framer-motion` ngoài `onboarding/flow/`.
3. `AppFrame` gọi `consumeHandoffArrival()` trong một effect sau mount. Việc tiêu thụ KHÔNG
   cần xảy ra trước khi vẽ, nên effect ở đây là đúng chỗ.
4. `src/app/(app)/layout.tsx` **không phải sửa gì.** Nó là Server Component và không đọc
   được store này — đó là lý do cách cookie từng được cân nhắc, và là lý do cách này tốt
   hơn: không có gì phải luồn qua tầng server cho một hiệu ứng thuần client.
5. **Không có rule tĩnh nào đặt `opacity: 0` lên app.** Trạng thái nghỉ là `opacity: 1`;
   keyframe chỉ tồn tại trong `no-preference`. Trường hợp xấu nhất là "không có hiệu ứng
   mờ" — không bao giờ là "app vô hình".

**Vì sao không cookie:** cookie cần `Max-Age`, cần tự xoá, cần đọc ở layout server, và vẫn
còn cửa sổ phát lại nếu xoá hỏng. Store module-scope tự biến mất khi tải lại trang — mà
"tải lại trang thì không phát hiệu ứng" chính là hành vi đúng, nên ở đây nó là tính năng
chứ không phải giới hạn.

**Vì sao không zustand:** repo hiện KHÔNG có zustand (không ở `package.json`, không ở
`pnpm-lock.yaml`, không import ở đâu trong `src/`). Store trên đúng bằng những gì zustand
sẽ làm cho ca này, trong ~20 dòng, theo đúng khuôn đã có sẵn hai bản trong repo. Nếu PM
muốn đưa zustand vào làm thư viện state chung của dự án thì đó là một quyết định riêng —
hỏi orchestrator, đừng tự thêm dependency.

Kết quả: nội dung khảo sát mờ đi trên nền cream → điều hướng xảy ra khi màn hình gần như
trống → app mờ lên từ đúng nền đó, với `SetupDock` đã có sẵn dữ liệu.

---

## 6. Trạng thái màn hình (core-feedback-states)

| Trạng thái | Màn chúc mừng làm gì |
|---|---|
| Loading | Không có. Nó chỉ xuất hiện sau khi `finish` đã thành công. |
| Data | Nội dung ở mục 3. |
| Empty | Không áp dụng — luôn có ít nhất tiêu đề + nút. |
| Error | Không có. Lỗi `finish` giữ người dùng ở bước 4; lỗi prefetch im lặng. |
| Partial | `useSetupProgress` chưa có/hỏng → ẩn khối "còn n bước", giữ nguyên phần còn lại. |
| Đang rời đi | Layer `inert` + `aria-hidden`, nút không bấm lại được. |

A11y bắt buộc:

- `<h1>` có `tabIndex={-1}` — `ScreenLayer` sẽ đưa focus vào nó khi stage đổi. Đây là điều
  hướng, focus phải đi theo.
- Dòng đếm ngược trong `role="status"` **có sẵn trong DOM từ khung hình đầu**, chỉ đổi nội
  dung. Một `role="status"` chèn vào cùng lúc với chữ của nó thường không được đọc.
- Emoji 🎉 trong `<h1>`: nằm trong cùng text node với chữ, không cần `aria-hidden` (nó đang
  ở trong tiêu đề và được đọc như một từ). Con dấu `Check` và quầng thì `aria-hidden`.
- Danh sách việc tiếp theo là `<ul>`/`<li>`, không phải div. Mỗi hàng **không** là link ở
  màn này — bấm vào sẽ rời luồng trước khi bàn giao chạy. Chỉ là chữ. `href` từ
  `SETUP_STEP_PRESENTATION` chưa dùng ở đây; dock trong app mới là chỗ bấm.
- Contrast: nút `bg-foreground text-background` đã đo 12.85:1 sáng / 13.82:1 tối ở
  `StepActions` — dùng lại đúng cặp token đó, không tự chọn màu khác.

---

## 7. Test bắt buộc

vitest `environment: "node"`, không jsdom. Đừng cố mô phỏng timer/DOM — viết đúng cái test
được, và **ghi rõ khoảng trống** như `StepActions.tsx` đã làm.

1. `celebrate-stage.test.ts` — 8 tổ hợp của `decideCelebrate`.
2. `onboarding-steps.test.ts` — bổ sung: `?step=celebrate` **không** được `resolveScreen`
   trả về; `ONBOARDING_SCREENS` vẫn đúng 5 phần tử; `nextScreen("channels") === "done"` vẫn
   đúng. Đây là test chống hồi quy cho quyết định 2.1.
3. `celebrate-screen-render.test.tsx` — `renderToStaticMarkup`:
   - có đúng một `<h1>` và nó có `tabindex="-1"`;
   - có `role="status"` kể cả khi `secondsLeft === null`;
   - `nextSteps` rỗng → không có `<ul>` nào, nhưng nút "Vào MYSP" vẫn có;
   - chữ của các hàng việc **khớp từng ký tự** với `SETUP_STEP_PRESENTATION` (chống việc
     chép chữ ra chỗ thứ hai).
4. `onboarding-motion.test.ts` — nới guard sang `CelebrateScreen.tsx`: không element nào
   mang class `.onboarding-enter*` mà đồng thời mang utility opacity/scale. Regex phải nhận
   cả tiền tố biến thể: `(^|:)-?(opacity|scale)-` — `^` sẽ bỏ sót `disabled:opacity-50`.
   **Guard phải có assert đếm** (`expect(checked).toBeGreaterThan(0)`) để không pass trên
   tập rỗng.
5. `onboarding-motion.test.ts` — mọi khai báo `animation`/`transition` mới nằm trong
   `no-preference`; không có `light-dark(` trong file CSS mới; không có `:root {` trong file
   CSS mới.
6. `motion-import-sweep.test.ts` — vẫn xanh (file CSS phía shell không được import
   `framer-motion`).
7. `handoff-motion` — test đọc file CSS: không có rule tĩnh nào đặt `opacity: 0` lên
   `.app-handoff-in` ngoài keyframe.
8. `useHandoffArrival.test.ts` — hàm thuần, chạy được ở node-env:
   `markHandoffArrival()` → snapshot `true`; `consumeHandoffArrival()` → `false`;
   `getServerSnapshot` luôn `false`; gọi `mark` hai lần liên tiếp không nhân đôi
   listener. Reset module state giữa các test (`vi.resetModules()`), nếu không test
   thứ hai sẽ đọc cờ của test thứ nhất — đúng cái bẫy mà store module-scope mang lại.

**Khoảng trống phải ghi bằng comment trong file test** (không tự bịa cách vá): timer 4s,
huỷ đếm ngược khi focus, cú fade 300ms trước `router.replace`, và cờ bàn giao thực sự
sống sót qua `router.replace` để `AppFrame` đọc được ngay khung hình đầu. Bốn thứ này chỉ trình duyệt chứng minh được.

---

## 8. Verify — dán output thật, không tóm tắt

```
pnpm typecheck
pnpm lint
pnpm depcruise
pnpm theme:check
pnpm test
pnpm build
```

hoặc `pnpm verify` (chạy đủ chuỗi trên + `theme:presets:check`).

`pnpm build` exit 0 **chưa chắc** có artifact — kiểm file thật sau khi build.

**Chứng minh trong trình duyệt (bắt buộc, gate không nhận nếu thiếu):**

Dựng dev server trong worktree này ở **port khác** (không giết tiến trình đang giữ port),
lưu PID rồi `kill "$PID"` khi xong. Giả lập `/api/me` bằng `page.route` để vào được đúng
vai owner — cách này đã ghi trong memory `mysp-verify-ui-states`.

Sáu thứ phải quay/chụp lại:

1. Bước 4 → "Tiếp tục" → màn chúc mừng **xuất hiện** (chứng minh race ở 2.3 đã xử lý).
2. `finish` hỏng (chặn request bằng `page.route`) → **không** có màn chúc mừng, ở lại bước 4
   kèm "Thử lại".
3. Đợi hết 4s → tự vào app, không nháy trắng, không nháy skeleton của `SetupDock`.
4. Bấm nút trước 4s → vào ngay, không có cú chuyển thứ hai.
5. Focus vào màn (Tab) → đếm ngược dừng và **không tự đi**.
6. `prefers-reduced-motion: reduce` (Playwright: `emulateMedia`) → không animation nào,
   không tự chuyển; `getAnimations()` trả rỗng.

Thêm: mở app **thật** ở route trong `(app)` để kiểm chữ trên nền tối (con dấu). Trang
`/onboarding-preview` nằm ngoài `AppFrame` nên **không** chứng minh được điều này — đã dính
thật hai lần.

---

## 9. Ngoài phạm vi

- Không đụng `resolveScreen`, `nextScreen`, `previousScreen`, `screenStep` (chỉ nới kiểu).
- Không sửa nội dung `OverviewScreen` hay hành vi `SetupDock` ngoài việc nó hưởng cache ấm.
- Không thêm dependency. Không thêm thư viện confetti.
- Không đổi wording của 6 bước thiết lập.
- Thấy vấn đề khác → **báo orchestrator, không tự sửa**.

## 10. Câu hỏi treo

- `PENDING(celebrate-autoadvance)` — 4s tự chuyển, hay chỉ có nút? Tạm dùng 4s + huỷ được.
- `PENDING(welcome-name)` đã có sẵn: `/api/me` không có email, tài khoản không tên thì màn
  chúc mừng chào không tên. Giữ nguyên cách `WelcomeScreen` đang làm, không bịa tên.

---

## 11. Đã dựng — khác kế hoạch ở đâu

| Mục | Kế hoạch | Thực tế | Vì sao |
|---|---|---|---|
| 2.3 | `useRef` dựng trước `await` | Hai ảnh chụp `completedAt` (lúc vào / bây giờ) | `react-hooks/refs` cấm đọc ref khi render; và so sánh dữ liệu thì không còn cửa sổ race để lỡ |
| 3.3 | Nền kẻ đóng khung hai đầu luồng | Bỏ, màn chúc mừng đứng trên vải trơn | Đo ở 1400×900: dòng việc thứ ba đè lên mark TikTok |
| 5.1 | `focusin` cũng huỷ đếm ngược | Chỉ `keydown` + `pointerdown` | `ScreenLayer` tự focus `<h1>`, nên focus sẽ huỷ đếm ngược ở mọi lần |
| 5.3 | Cookie `mysp_handoff` | Store module-scope (`useHandoffArrival`) | Đã sửa trong prompt trước khi dựng — xem mục 5.3 |

**File đã thêm:** `celebrate-stage.ts` (+test), `CelebrateScreen.tsx` (+test),
`useCelebrateHandoff.ts`, `useHandoffArrival.ts` (+test), `shell/handoff-motion.css`.
**File đã sửa:** `onboarding-steps.ts`, `onboarding-motion.ts`, `onboarding-motion.css`,
`OnboardingFrame.tsx`, `OnboardingFlow.tsx`, `StepDots.tsx`, `AppFrame.tsx`, và bốn file
test hiện có.

**Kiểm chứng:** `pnpm verify` exit 0 (327 file test, 5649 test, build ra artifact) +
20/20 kịch bản trình duyệt bằng Playwright (7 cảnh của mục 8, cộng sáng/tối và một lượt
quét lỗi console).
