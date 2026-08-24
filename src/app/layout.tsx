import type { Metadata } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";

import { readAppearancePreset } from "@/app/_lib/appearance";
import { APPEARANCE_PRESET_ATTRIBUTE } from "@/shared/appearance-presets";

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

/**
 * Session-independent, but NOT static: the appearance preset (M3.4) is read
 * here so the first paint already carries the right dye. The gate behind
 * `readAppearancePreset` caches it, so this costs one query a minute per
 * process rather than one per page view.
 */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const themePreset = await readAppearancePreset();

  return (
    <html
      lang="vi"
      /* The preset's stylesheet is already in the <head> (globals.css imports
         it), and it is scoped to this attribute — so the colour arrives with
         the markup and never flips after hydration. */
      {...{ [APPEARANCE_PRESET_ATTRIBUTE]: themePreset }}
      className={`${appSans.variable} ${appMono.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        {/* Direction contract (new-work §5): the approved "Sổ mẫu vải" brief travels
            with the markup, so any later change can be checked against it. Written
            unaccented on purpose — it must survive any transport that mangles UTF-8. */}
        <div
          hidden
          aria-hidden="true"
          data-direction-contract
          dangerouslySetInnerHTML={{
            __html: `<!--
THESIS: MYSP la so mau vai cua xuong: moi mau la mot the vai, moi ma san pham mot trang mau; tu choi admin-SaaS card trang + accent tim rai deu.
OWN-WORLD: nen vai moc oklch(0.955 0.013 84), muc am, cham indigo hanh dong, the mau bao hoa canh bac thang, nhan det mono cho ma/so.
STORY: nguoi van hanh mo so mau, thay viec hom nay, rut the soan bai, duyet caption, luon tra loi duoc "vi sao bai nay khong len".
FIRST VIEWPORT: hang so lieu tren nhan det (bam duoc) + viec can chu y + chong the lo dang chay; mot hanh dong chinh "Soan bai moi".
FORM: grounded #4 vong 2, seed e06531fb.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->`,
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
