import type { Metadata } from "next";
import { FunctionRows, KeyRows } from "@/components/shell/help-overlay";
import { KeyValue } from "@/components/ui/key-value";
import { Pane } from "@/components/ui/pane";

export const metadata: Metadata = { title: "Help · MA Terminal" };

const SOURCES = [
  { label: "Prices", value: "NSE bhavcopy · Yahoo chart API" },
  { label: "Fundamentals", value: "Screener.in consolidated statements" },
  { label: "Research", value: "Moneycontrol broker reports and consensus" },
  { label: "Filings", value: "NSE corporate announcements" },
  {
    label: "Supply chain",
    value: "Order filings · annual reports · concalls · rating rationales, evidence-cited",
  },
  { label: "Travel", value: "ADS-B · OpenSky · adsb.lol · DGCA registry" },
  { label: "Logistics", value: "AISStream positions · facility geofences" },
  { label: "Intelligence", value: "gpt-oss-120b on Cerebras, evidence-cited" },
];

export default function HelpPage() {
  return (
    <div className="grid grid-help">
      <Pane id="keys" title="KEYBOARD" meta="? toggles overlay" pad>
        <KeyRows />
      </Pane>
      <Pane id="functions" title="FUNCTIONS" meta="⌃K then type" pad>
        <FunctionRows />
      </Pane>
      <Pane id="sources" title="DATA SOURCES" meta="Asia/Kolkata">
        <KeyValue label="Data sources" groups={[{ items: SOURCES }]} />
        <p className="pane-section dim sm">
          Alt-data reads are proxies: corporate association is not passenger identity and facility
          geofence matches are not confirmed cargo ownership.
        </p>
        <p className="pane-section dim sm">
          SPLC shows only evidence-cited edges: each link carries its value basis (revenue share,
          purchase share, annual flow or contract total), cost bucket, period, confidence and up to
          three source quotes. Contract totals are never summed into annual flow, legacy and expired
          edges are hidden, and the coverage pane shows filings read per source. Low-confidence or
          new-counterparty observations wait in the operator queue at /admin/review.
        </p>
      </Pane>
    </div>
  );
}
