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
  {
    label: "Influence",
    value: "NSE governance XBRL (DIN) · NSE related-party XBRL · shareholding pattern",
  },
  {
    label: "Political",
    value: "Sansad members · MyNeta affidavits · SBI electoral bond disclosures",
  },
  { label: "Policy", value: "PIB releases · PRS bill tracker · eGazette · NSE industry" },
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
        <p className="pane-section dim sm">
          INFL maps who sits on the board, who controls the company and which entities it transacts
          with. Directors are keyed by DIN, never by name; name-only matches stay pending until an
          operator confirms them. Every confirmed link cites a filing span, the change feed starts
          after the first read of each filing, and related-party transactions are flagged as
          material from ₹10 Cr or 1% of revenue, whichever is lower.
        </p>
        <p className="pane-section dim sm">
          Documented political links appear only when every hop from the company to the office,
          party or donation is a confirmed edge with a cited span. Structured records with an
          identifier confirm at 98%, two primary documents at 95%; a single document with a name
          match tops out at 80% and news or inference at 60%, and both wait at /admin/review. Policy
          events reach a company by name or through its NSE industry sector, tagged by ministry
          rules first and by the model only from the policy text.
        </p>
      </Pane>
    </div>
  );
}
