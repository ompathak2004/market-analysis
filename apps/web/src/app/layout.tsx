import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Clock } from "@/components/clock";
import { CommandBar } from "@/components/command-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: "MA Terminal",
  description: "Indian equities intelligence terminal",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="terminal">
          <header className="topbar">
            <a href="/" className="brand">
              MA<span>/TERMINAL</span>
            </a>
            <CommandBar />
            <div className="topbar-right">
              <span>NSE</span>
              <Clock />
            </div>
          </header>
          <main className="main">{children}</main>
          <footer className="statusbar">
            <span>
              <kbd>CTRL+K</kbd> command
            </span>
            <span>
              <kbd>DES</kbd> <kbd>GP</kbd> <kbd>FA</kbd> <kbd>ANR</kbd> <kbd>SPLC</kbd>{" "}
              <kbd>NEWS</kbd> + symbol
            </span>
            <span>
              <kbd>HOME</kbd> <kbd>MOV</kbd> <kbd>SIG</kbd>
            </span>
            <span style={{ marginLeft: "auto" }}>
              data: NSE · Screener · Yahoo · Trendlyne · filings
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
