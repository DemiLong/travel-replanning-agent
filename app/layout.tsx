import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dayshift — 今日行程救援",
  description: "下雨、迟到、疲惫或计划失效时，帮你救回今天接下来的行程。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
