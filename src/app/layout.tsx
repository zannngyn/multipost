import type { Metadata } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";

/**
 * The approved design draws in Outfit, which ships latin + latin-ext only —
 * every Vietnamese tone mark would fall back to a different face mid-word. Be
 * Vietnam Pro is the same geometric sans register and was drawn for this
 * script, so the diacritics come from the same family as the letters.
 */
const appSans = Be_Vietnam_Pro({
  variable: "--font-app-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "vietnamese"],
  display: "swap",
});

/** Codes, ids and counts: they line up in a column only in a mono face. */
const appMono = JetBrains_Mono({
  variable: "--font-app-mono",
  subsets: ["latin", "vietnamese"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "MYSP — Đăng bài tự động",
  description: "Công cụ đăng bài tự động cho Facebook và TikTok",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${appSans.variable} ${appMono.variable} h-full antialiased`}>
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
