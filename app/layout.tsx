import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dayshift — Dynamic Travel Replanning",
  description:
    "Replan the rest of today around rain, energy and the reservations that matter.",
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
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
