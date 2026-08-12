# Kiến trúc & Stack — Clean Architecture một chiều

**Ngày:** 12/08/2026 · Áp dụng cho toàn bộ code Phase 1 trở đi. Mọi agent domain code theo tài liệu này; `reviewer-qa` FAIL mọi diff vi phạm luật phụ thuộc.

---

## 1. Stack (đã chốt — doc 02, nhắc lại để đủ ngữ cảnh)

| Lớp | Công nghệ | Ghi chú |
|---|---|---|
| Web app | Next.js App Router + TypeScript `strict` | Một codebase UI + API |
| DB | PostgreSQL + Drizzle ORM | Transaction thật; migration rõ ràng |
| Queue + scheduler | **BullMQ + Redis** *(đổi 12/08 — quyết định owner)* | Redis kiêm: cache nóng registry, rate-limit AI/Graph adapter |
| Worker | Node.js, cùng repo, entrypoint riêng | Mọi I/O bên ngoài chạy ở đây |
| UI | Tailwind + shadcn/ui | |
| Validate | zod | Schema tại mọi biên |
| Server state FE | TanStack Query | Không đưa server state vào global store |
| AI | **AI Gateway đa provider** — Google (paid tier) primary, OpenAI fallback; registry YAML+DB, cache Redis | ADR-001 + `docs/ai/` |
| Google | Service Account (Drive + Sheets) | |
| Media check | ffprobe/ffmpeg | Phase 2 (video) |
| Deploy | Docker Compose trên 1 VPS + Caddy | |
| Log | pino (structured JSON) | Theo chuẩn kỹ thuật CLAUDE.md |

---

## 2. Cấu trúc thư mục & luật phụ thuộc MỘT CHIỀU

```
src/
├── core/                    # ❤️ TRÁI TIM — thuần TypeScript, KHÔNG phụ thuộc gì bên ngoài
│   ├── domain/              # entity, value object, error code, rule nghiệp vụ thuần
│   │   ├── product.ts       #   Product, MediaAsset, màu chuẩn hoá
│   │   ├── post-job.ts      #   PostJob + máy trạng thái
│   │   ├── inventory.ts     #   bảng quyết định tồn kho (pure function)
│   │   ├── caption.ts       #   rule caption + validator thuần (regex giá, hashtag...)
│   │   └── errors.ts        #   AppError + toàn bộ error code
│   ├── usecases/            # application service — điều phối domain, gọi qua PORT
│   │   ├── sync-catalog.ts  #   đồng bộ Drive + Sheet → snapshot
│   │   ├── compose-post.ts  #   tra sheet → tồn kho → gom media
│   │   ├── generate-captions.ts #   gọi ContentEngine (core/ai — gateway, routing, validation: docs/ai)
│   │   └── publish-post.ts  #   khoá trùng → recheck tồn → đăng
│   └── ports/               # interface cho MỌI thứ bên ngoài
│       ├── product-repo.ts  #   ProductRepo, MediaRepo, PostJobRepo
│       ├── drive-source.ts  #   DriveSource, SheetSource
│       ├── content-engine.ts#   ContentEngine (AI — platform-aware, xem docs/ai)
│       ├── ai.ts            #   AIProviderAdapter, ModelPolicyStore, PromptStore, GenerationLog
│       ├── publisher.ts     #   ChannelPublisher (FB, sau này TikTok)
│       └── infra.ts         #   Logger, Clock, JobQueue
│
├── adapters/                # implement ports — MỌI I/O nằm đây
│   ├── db/                  # Drizzle schema + repository (implement *-repo)
│   ├── google/              # Drive/Sheet client (implement drive-source)
│   ├── ai/                  # AI providers: google/, openai/ (implement AIProviderAdapter), registry-store/
│   ├── meta/                # Graph API (implement publisher)
│   └── queue/               # BullMQ/Redis (implement job-queue)
│
├── composition/             # ROOT nối dây — nơi DUY NHẤT biết cả core lẫn adapters
│   └── container.ts         # factory: makeUsecases(deps) — DI bằng hàm, không framework
│
├── app/                     # Next.js (interface layer — web)
│   ├── api/                 # route handler MỎNG: zod-validate → gọi usecase → map AppError→HTTP
│   └── (screens)/           # Server Component mặc định
│
├── worker/                  # entrypoint worker (interface layer — jobs)
│   └── index.ts             # đăng ký handler MỎNG: validate payload → gọi usecase
│
├── ui/                      # FE thuần trình bày (xem mục 4)
│   ├── components/          # UI — chỉ render
│   ├── hooks/               # logic FE (useX)
│   ├── services/            # *.api.ts — gọi HTTP API nội bộ
│   └── schemas/             # *.schema.ts — zod cho form
│
└── shared/                  # types + utils THUẦN (không I/O, không side effect)
```

### Luật vàng — KHÔNG GỌI NGƯỢC

Mũi tên phụ thuộc chỉ được chạy **từ ngoài vào trong**:

```
app / worker / ui  →  composition  →  adapters  →  core  →  (không gì cả)
                                        shared ← ai cũng được import
```

| Từ ↓ import → | core | ports | adapters | composition | app/worker | ui | shared |
|---|---|---|---|---|---|---|---|
| **core** (domain/usecases) | ✅ nội bộ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **adapters** | ✅ (types, ports, errors) | ✅ | ⚠️ chỉ trong cùng adapter | ❌ | ❌ | ❌ | ✅ |
| **composition** | ✅ | ✅ | ✅ | — | ❌ | ❌ | ✅ |
| **app (API route, RSC)** | ⚠️ chỉ types + error code | ❌ | ❌ | ✅ (lấy usecase) | ✅ nội bộ | ✅ | ✅ |
| **worker** | ⚠️ chỉ types + error code | ❌ | ❌ | ✅ | ✅ nội bộ | ❌ | ✅ |
| **ui** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ nội bộ | ✅ types |

**Các vi phạm kinh điển — reviewer-qa FAIL thẳng:**
- `core/**` import `drizzle-orm`, `googleapis`, SDK AI (`@google/genai`, `openai`, `@anthropic-ai/*`), `next/*`, `bullmq`, `ioredis` — core không được biết thế giới bên ngoài tồn tại
- `adapters/meta` import `usecases/*` (adapter gọi ngược lên usecase)
- `ui/components` import `adapters/db/schema` (UI xuyên thẳng xuống DB — lấy type qua `shared/` hoặc DTO của API)
- API route tự viết business logic thay vì gọi usecase (logic rò ra interface layer)
- usecase `new DrizzleProductRepo()` trực tiếp thay vì nhận qua tham số (tự nối dây = gọi ngược composition)

---

## 3. Clean Architecture cho BE

### 3.1. Bốn lớp, trách nhiệm một câu

| Lớp | Trả lời câu hỏi | Được biết gì |
|---|---|---|
| `domain` | "Nghiệp vụ nói gì?" — tồn kho chặn khi nào, caption hợp lệ ra sao, post_job chuyển trạng thái thế nào | Chỉ chính nó. Pure function tối đa |
| `usecases` | "Một hành động diễn ra theo thứ tự nào?" — compose → check tồn → AI → validate → duyệt → đăng | domain + **interface** của ports |
| `adapters` | "Nói chuyện với X như thế nào?" — Drizzle, Drive, Graph API, AI providers, BullMQ/Redis | ports nó implement + lib bên ngoài của riêng nó |
| `app`/`worker` | "Ai kích hoạt và trả kết quả cho ai?" — HTTP, cron, job | composition (để lấy usecase đã nối dây) |

### 3.2. Mẫu port + usecase + composition (khuôn cho mọi feature)

```ts
// core/ports/product-repo.ts — core ĐỊNH NGHĨA nhu cầu
export interface ProductRepo {
  findByCode(tenantId: string, code: string): Promise<Product | null>;
}

// core/usecases/compose-post.ts — nhận port qua deps, KHÔNG tự tạo
export function makeComposePost(deps: {
  products: ProductRepo; media: MediaRepo; logger: Logger;
}) {
  return async function composePost(input: ComposePostInput): Promise<ComposeResult> {
    // EDGE CASE TRƯỚC (chuẩn kỹ thuật CLAUDE.md):
    const product = await deps.products.findByCode(input.tenantId, input.code);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', { code: input.code });
    const gate = checkInventory(product);            // domain pure function
    if (gate.blocked) throw new AppError('OUT_OF_STOCK', { code: input.code, reason: gate.reason });
    // ... happy path cuối cùng
  };
}

// composition/container.ts — nơi DUY NHẤT nối interface với implementation
export function makeUsecases(cfg: Config) {
  const db = makeDb(cfg);
  const deps = {
    products: new DrizzleProductRepo(db),
    media: new DrizzleMediaRepo(db),
    logger: makePinoLogger(cfg),
  };
  return { composePost: makeComposePost(deps), /* ... */ };
}

// app/api/posts/route.ts — interface layer MỎNG (≤ ~30 dòng)
export async function POST(req: Request) {
  const parsed = ComposePostSchema.safeParse(await req.json());   // validate tại biên
  if (!parsed.success) return jsonError(400, 'INVALID_INPUT', parsed.error);
  try {
    return Response.json(await usecases.composePost(parsed.data));
  } catch (e) {
    return mapAppErrorToHttp(e);   // global error mapping — một chỗ duy nhất
  }
}
```

### 3.3. Dòng chảy lỗi (khớp chuẩn AppError trong CLAUDE.md)

```
adapters:  lỗi lib ngoài (Drizzle/Graph/googleapis) → wrap thành AppError(code, cause)
core:      chỉ throw AppError với error code nghiệp vụ (OUT_OF_STOCK, CAPTION_PRICE_LEAK...)
app:       mapAppErrorToHttp — một bảng code → status + userMessage tiếng Việt
worker:    handler bắt AppError → chuyển trạng thái job + log; lỗi lạ → fail job + log stack
process:   unhandledRejection/uncaughtException → log rồi exit(1), Docker restart
```

Lỗi từ dưới lên chỉ đi qua **một loại** (AppError) và được dịch ở **một chỗ** mỗi interface. Không có `catch` dọc đường "xử lý giùm".

### 3.4. Vì sao web và worker chung core

`publish-post` usecase được gọi từ cả API route (đăng ngay) và worker (hẹn lịch, thử lại) — cùng một hàm, cùng khoá chống trùng, cùng recheck tồn kho. Nếu logic nằm trong route handler thì worker phải chép lại — đó chính là nguồn lỗi ghép nối mà kiến trúc này chặn.

---

## 4. Clean Architecture cho FE

Theo skill `frontend-architecture` + bộ skill cá nhân (`core-state-architecture`, `core-form-architecture`, `core-feedback-states` — ui-web agent tra `SKILL-MAP.md` trước khi code từng màn).

### 4.1. Bốn lớp FE — một file một trách nhiệm

| Lớp | Nằm ở | Làm gì | KHÔNG làm gì |
|---|---|---|---|
| UI | `ui/components/` | Render, nhận props đã sẵn dữ liệu | Fetch, transform, business branch |
| Logic | `ui/hooks/` (`useComposePost`, `useCaptionReview`) | State, effect, transform | Gọi fetch trực tiếp — gọi qua service |
| Data | `ui/services/*.api.ts` | Gọi HTTP API nội bộ, khai báo query key | Business logic, render |
| Type/Schema | `shared/types` + `ui/schemas/*.schema.ts` | DTO, zod form schema | — |

Chuỗi một chiều trong FE: `component → hook → service → HTTP API` — component không nhảy cóc gọi service, service không import component/hook (gọi ngược).

### 4.2. FE không gọi ngược xuống BE

- **Client Component**: CHỈ nói chuyện với BE qua HTTP API nội bộ (`ui/services/*.api.ts` + TanStack Query). Cấm import `core/`, `adapters/`, `composition/`.
- **Server Component**: được gọi usecase qua `composition` (không cần vòng qua HTTP) — vẫn đúng chiều vì RSC thuộc interface layer. Cấm import thẳng `adapters/db`.
- Type dùng chung FE–BE đặt ở `shared/` dưới dạng DTO — FE không bao giờ thấy Drizzle schema.

### 4.3. Quy tắc còn lại (áp nguyên từ skill)

- Server Component mặc định; `"use client"` chỉ ở lá nhỏ nhất (form, modal, nút) — không client-hoá cả page vì một nút.
- State theo tầng: local `useState` → hook dùng lại → Context cho subtree → TanStack Query cho server state. **Không Zustand/Redux ngày một** — chỉ thêm khi có nhu cầu thật và được duyệt.
- Form: react-hook-form + zod, schema ở `*.schema.ts` cạnh form.
- Component >200 dòng / >3 useEffect / vừa render vừa fetch → tách theo đường nối của trang.
- Mỗi màn hình đủ trạng thái theo `core-feedback-states` (tối thiểu loading/data/empty/error).
- Đặt tên mô tả: `CaptionReviewPanel.tsx`, `useComposePost.ts`, `post.api.ts`, `compose-post.schema.ts`.

---

## 5. Cưỡng chế luật một chiều bằng máy, không bằng trí nhớ

1. **ESLint `no-restricted-imports`** (hoặc `eslint-plugin-boundaries`) — chặn ngay lúc code:

```jsonc
// eslint: cấu hình theo zone — ví dụ zone core
{
  "files": ["src/core/**"],
  "rules": { "no-restricted-imports": ["error", { "patterns": [
    { "group": ["drizzle-orm*", "googleapis*", "@anthropic-ai/*", "@google/genai*", "openai*", "next*", "bullmq*", "ioredis*", "react*"],
      "message": "core không được import framework/lib I/O — dùng port" },
    { "group": ["@/adapters/*", "@/app/*", "@/worker/*", "@/ui/*", "@/composition/*"],
      "message": "core không được import lớp ngoài (không gọi ngược)" }
  ]}]}
}
```

2. **dependency-cruiser trong CI** — vẽ + fail khi có cạnh ngược (`npx depcruise src --validate`), rule khai báo đúng bảng ma trận mục 2.
3. **reviewer-qa**: checklist có mục "luật phụ thuộc một chiều" — vi phạm là FAIL thẳng, cùng nhóm với nuốt lỗi.

Hai công cụ trên thuộc E1 (nền tảng) — dựng ngay từ commit đầu, đắt hơn ~0.5 MD, rẻ hơn mọi lần gỡ import ngược về sau.

---

## 6. Ánh xạ agent ↔ thư mục sở hữu

| Agent | Sở hữu | Được đọc |
|---|---|---|
| `data-pipeline` | `core/domain/{product,inventory}*`, `core/usecases/{sync-catalog,compose-post}`, `adapters/{db,google}` | tất cả |
| `caption-ai` | `core/domain/caption*`, `core/ai/**`, `core/usecases/generate-captions`, `adapters/ai/**`, `config/ai-models.yaml` | tất cả |
| `fb-publisher` | `core/domain/post-job*`, `core/usecases/publish-post`, `adapters/{meta,queue}`, `worker/` | tất cả |
| `ui-web` | `ui/**`, `app/(screens)/**`, `app/api/**` (route mỏng) | `shared/`, `composition/` (chỉ gọi) |
| `reviewer-qa` | không sở hữu — kiểm tất cả | tất cả |

Port chung (`core/ports/*`) và `composition/` là **vùng chung**: agent nào cần đổi interface thì đề xuất qua orchestrator, không tự ý sửa — đổi port là đổi hợp đồng của nhiều agent.
