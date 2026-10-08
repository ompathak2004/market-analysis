import type { Tab } from "@/lib/commands";
import { AnrView } from "./anr";
import { DesView } from "./des";
import { FaView } from "./fa";
import { GpView, parseRange } from "./gp";
import { IntlView } from "./intl";
import { JetView } from "./jet";
import { NewsView, parseAnnouncementId } from "./news";
import { parseCallFilter, ShipView } from "./ship";
import { SplcView } from "./splc";

export type SearchParams = Record<string, string | string[] | undefined>;

export function TabView({ symbol, tab, sp }: { symbol: string; tab: Tab; sp: SearchParams }) {
  switch (tab) {
    case "des":
      return <DesView symbol={symbol} />;
    case "gp":
      return <GpView symbol={symbol} range={parseRange(sp.range)} />;
    case "fa":
      return <FaView symbol={symbol} />;
    case "anr":
      return <AnrView symbol={symbol} />;
    case "splc":
      return <SplcView symbol={symbol} />;
    case "news":
      return <NewsView symbol={symbol} selected={parseAnnouncementId(sp.a)} />;
    case "jet":
      return <JetView symbol={symbol} />;
    case "ship":
      return <ShipView symbol={symbol} filter={parseCallFilter(sp.calls)} />;
    case "intl":
      return <IntlView symbol={symbol} />;
  }
}
