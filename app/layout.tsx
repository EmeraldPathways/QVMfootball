import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QVM Football Workbench",
  description:
    "Private quantitative value modeling and football paper-trading workbench.",
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
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
