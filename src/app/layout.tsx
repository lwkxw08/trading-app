import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "TradeIntel — AI Trading Intelligence",
  description:
    "AI-powered market analysis, confluence-scored opportunities, and TradingView indicator generation across crypto, stocks and futures.",
};

const NAV = [
  { href: "/", label: "Command Center" },
  { href: "/scanner", label: "Scanner" },
  { href: "/analyze", label: "Analysis" },
  { href: "/indicators", label: "Indicator Studio" },
  { href: "/calendar", label: "Macro Calendar" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}>
        <header className="sticky top-0 z-20 border-b border-edge bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-bold tracking-tight">
              Trade<span className="text-accent">Intel</span>
            </Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-1.5 text-muted transition-colors hover:bg-edge hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-muted">
          TradeIntel provides market analysis for educational purposes only and is not financial advice. Trading
          involves substantial risk of loss.
        </footer>
      </body>
    </html>
  );
}
