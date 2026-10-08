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
  { label: "Supply chain", value: "Related-party and annual-report disclosures" },
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
      </Pane>
    </div>
  );
}
