import type { Metadata, Viewport } from "next";
import Link from "next/link";
import Script from "next/script";
import { type ReactNode, Suspense } from "react";
import { Clock } from "@/components/shell/clock";
import { CommandBar } from "@/components/shell/command-bar";
import { HelpOverlay } from "@/components/shell/help-overlay";
import { MarketStrip } from "@/components/shell/market-strip";
import { RefreshOnInterval } from "@/components/shell/refresh-on-interval";
import { StatusHints } from "@/components/shell/status-hints";
import { TerminalController } from "@/components/shell/terminal-controller";
import { mono } from "@/styles/fonts";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/grid.css";
import "@/styles/pane.css";
import "@/styles/table.css";
import "@/styles/controls.css";
import "@/styles/charts.css";
import "@/styles/utilities.css";
import "@/styles/admin.css";

export const metadata: Metadata = {
  title: "MA Terminal",
  description: "Indian equities intelligence terminal",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
};

const DENSITY_SCRIPT =
  "try{var d=localStorage.getItem('ma:density');if(d)document.documentElement.dataset.density=d}catch(e){}";

const SOURCES = "NSE · Yahoo · Screener · Moneycontrol · NSE filings · ADS-B · AIS · gpt-oss-120b";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable} data-density="comfortable" suppressHydrationWarning>
      <body>
        <Script id="density" strategy="beforeInteractive">
          {DENSITY_SCRIPT}
        </Script>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              MA<span>/TERMINAL</span>
            </Link>
            <CommandBar />
            <Suspense fallback={<div className="market-strip" />}>
              <MarketStrip />
            </Suspense>
            <Clock />
          </header>
          <main className="screen">{children}</main>
          <footer className="statusbar">
            <StatusHints />
            <div className="status-sources truncate">{SOURCES}</div>
          </footer>
        </div>
        <HelpOverlay />
        <RefreshOnInterval seconds={120} />
        <TerminalController />
      </body>
    </html>
  );
}
