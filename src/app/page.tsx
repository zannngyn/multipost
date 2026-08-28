import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MYSP — Trang sản phẩm",
  description: "Trang giới thiệu sản phẩm MYSP",
};

export default function LandingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <h1 className="text-2xl font-bold">trang giới thiệu SaaS</h1>
    </main>
  );
}
