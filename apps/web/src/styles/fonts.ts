import localFont from "next/font/local";

export const mono = localFont({
  src: [{ path: "./fonts/JetBrainsMono[wght].woff2", style: "normal", weight: "100 800" }],
  variable: "--font-mono",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
