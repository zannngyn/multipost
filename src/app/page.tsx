import Link from "next/link";

import { Button } from "@/ui/components/ui/button";

/** Placeholder home screen — real screens land in E10 (wizard, duyệt caption, theo dõi). */
export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">MYSP — Đăng bài tự động</h1>
        <p className="text-muted-foreground">
          Nền tảng đã dựng xong. Các màn hình vận hành sẽ được bổ sung ở các sprint tiếp theo.
        </p>
      </div>
      <div>
        <Button asChild>
          <Link href="/api/health">Kiểm tra tình trạng hệ thống</Link>
        </Button>
      </div>
    </main>
  );
}
