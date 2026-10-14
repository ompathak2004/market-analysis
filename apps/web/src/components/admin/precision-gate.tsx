import type { ReactNode } from "react";
import { Badge } from "@/components/ui/chip";
import { pct } from "@/lib/format";
import { familyLabel } from "@/lib/splc";
import type { PrecisionSummary } from "@/server/queries";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="review-gate-stat">
      <span className="muted">{label}</span>
      <span className="num">{children}</span>
    </span>
  );
}

export function PrecisionGate({ summary }: { summary: PrecisionSummary }) {
  const { sample, counts } = summary;
  const dropped = sample.size - counts.items;
  return (
    <div className="review-gate">
      <span className="bright">{sample.name}</span>
      <span className="muted">{sample.family ? familyLabel(sample.family) : "ALL SOURCES"}</span>
      <Stat label="REVIEWED">{`${counts.reviewed}/${sample.size}`}</Stat>
      <Stat label="CONFIRMED">{counts.confirmed}</Stat>
      <Stat label="REJECTED">{counts.rejected}</Stat>
      <Stat label="BLOCKED">{counts.blocked}</Stat>
      <Stat label="PRECISION">
        {summary.precision == null ? "—" : pct(summary.precision * 100, 1, false)}
      </Stat>
      <Stat label="LOWER 95%">{pct(summary.lowerBound * 100, 1, false)}</Stat>
      <Stat label="GATE">{`≥ ${pct(summary.gate * 100, 0, false)}`}</Stat>
      {dropped > 0 ? (
        <span className="warn" title="Observations deleted since the draw; the gate cannot pass">
          {`${dropped} DROPPED`}
        </span>
      ) : null}
      <span className="grow" />
      <Badge
        tone={summary.passes ? "pos" : "neg"}
        title="Passes when every sampled observation has a decision and the 95% Wilson lower bound on precision reaches the gate"
      >
        {summary.passes ? "PASS" : "FAIL"}
      </Badge>
    </div>
  );
}
