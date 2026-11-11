import { DEMO_PORTFOLIOS, portfolioSymbols } from "@ma/agent";
import type { Metadata } from "next";
import { BotApp } from "@/components/bot/bot-app";

export const metadata: Metadata = { title: "Analyst · MA Terminal" };

const SUGGESTIONS = [
  {
    label: "Research notes",
    items: [
      "Write a research note on SHRIPISTON",
      "Write a research note on BEL",
      "Write a research note on RELIANCE",
    ],
  },
  {
    label: "Portfolio",
    items: [
      "Analyze my portfolio",
      "Why is my portfolio up or down this week?",
      "Compare my portfolio against its benchmark",
      "What happens if my largest holding falls 15%?",
    ],
  },
  {
    label: "News & intelligence",
    items: [
      "How does the latest news affect my portfolio?",
      "Which holdings have deteriorating customer momentum?",
      "What do our aircraft and vessel signals indicate for my holdings?",
      "Show BEL's supply-chain exposure",
    ],
  },
  {
    label: "Tax",
    items: [
      "Estimate my capital gains tax if I sell everything today",
      "Which holdings have unrealized short-term gains?",
      "Explain STCG versus LTCG for Indian equities",
    ],
  },
  {
    label: "Research",
    items: [
      "Compare HAL and BEL",
      "Plot BEL's quarterly revenue",
      "What are the major risks for HDFCBANK?",
    ],
  },
];

export default function BotPage() {
  const portfolios = DEMO_PORTFOLIOS.map((p) => ({
    id: p.id,
    name: p.name,
    thesis: p.thesis,
    risk: p.risk,
    benchmark: p.benchmark,
    holdings: portfolioSymbols(p).length,
  }));
  return (
    <div className="grid grid-bot">
      <BotApp portfolios={portfolios} suggestions={SUGGESTIONS} />
    </div>
  );
}
