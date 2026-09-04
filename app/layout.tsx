import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ad Creatives Tool",
  description: "Scenario to finished vertical ad, with an AI QA gate at every step.",
};

/**
 * Resolves the theme before first paint.
 *
 * Has to be inline and synchronous in <head>: any later and the page paints in the
 * wrong theme first, so a user who picked Light on a dark machine gets a flash of dark
 * on every navigation.
 *
 * It resolves "system" to an explicit attribute rather than leaving CSS to a media
 * query. That keeps the palette defined exactly once, under [data-theme="dark"] —
 * a second copy inside a media query is a copy that drifts, which is the shape of the
 * bug this whole change is fixing. ThemeToggle keeps it in step with the OS afterwards.
 */
const THEME_SCRIPT = `try{var s=localStorage.getItem("ad-creatives-theme");var d=s==="dark"||(s!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.setAttribute("data-theme","dark")}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
