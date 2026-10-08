import { Chg } from "@/components/ui/num";
import { num } from "@/lib/format";
import { getContext } from "@/server/context";
import { marketOverview } from "@/server/queries";

const STRIP = ["^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX", "USDINR=X", "BZ=F"];

function stateLabel(s: string | null): { text: string; tone: "pos" | "warn" | "neu" } {
  const v = (s ?? "").toUpperCase();
  if (v === "REGULAR") return { text: "OPEN", tone: "pos" };
  if (v.startsWith("PRE")) return { text: "PRE", tone: "warn" };
  if (v.startsWith("POST")) return { text: "POST", tone: "warn" };
  return { text: "CLOSED", tone: "neu" };
}

export async function MarketStrip() {
  const ctx = getContext();
  const overview = await marketOverview(ctx).catch(() => null);
  const items = STRIP.map((s) => overview?.indices.find((i) => i.symbol === s)).filter(
    (i): i is NonNullable<typeof i> => i != null,
  );
  const state = stateLabel(items[0]?.marketState ?? null);
  return (
    <div className="market-strip">
      <span className="badge" data-tone={state.tone === "neu" ? undefined : state.tone}>
        NSE {state.text}
      </span>
      {items.map((i) => (
        <span key={i.symbol} className="ms-item">
          <span className="ms-name">{i.name}</span>
          <span className="ms-last">{num(i.price, i.symbol === "USDINR=X" ? 2 : 0)}</span>
          <Chg v={i.changePct} pct />
        </span>
      ))}
    </div>
  );
}
