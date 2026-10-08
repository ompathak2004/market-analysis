import { Callout, CalloutGroup } from "@/components/ui/callout";
import { Badge } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { num, pct, shortDate, signalLabel } from "@/lib/format";
import type { SignalRow } from "@/server/queries/types";

export function sourceLabels(sources: readonly string[]): string {
  const out = new Set<string>();
  for (const s of sources) {
    try {
      out.add(new URL(s).hostname.replace(/^www\./, "").replace(/^api\./, ""));
    } catch {
      out.add(s);
    }
  }
  return [...out].slice(0, 4).join(" · ");
}

export function confidenceBadge(c: number | null | undefined) {
  if (c == null) return <Badge tone="neu">UNRATED</Badge>;
  if (c >= 0.75) return <Badge tone="pos">HIGH CONF.</Badge>;
  if (c >= 0.45) return <Badge tone="warn">MEDIUM CONF.</Badge>;
  return <Badge tone="neg">LOW CONF.</Badge>;
}

export function altValue(kind: string, v: number | null): string {
  if (v == null) return "—";
  if (/coverage/.test(kind)) return pct(v <= 1 ? v * 100 : v, 0, false);
  if (/anomaly|congestion|throughput|activity/.test(kind)) return num(v, 2);
  return num(v, Number.isInteger(v) ? 0 : 1);
}

function baselineText(s: SignalRow): string {
  const b = s.inputs.baseline;
  if (!b) return `${shortDate(s.inputs.window.from)} – ${shortDate(s.inputs.window.to)}`;
  return `vs ${num(b.mean, 1)} baseline · ${shortDate(b.from)} – ${shortDate(b.to)}`;
}

export function AltSignalsPane({
  layer,
  signals,
  sources,
  lastSampleAt,
}: {
  layer: "air" | "sea";
  signals: readonly SignalRow[];
  sources: readonly string[];
  lastSampleAt: string | null;
}) {
  const title = layer === "air" ? "TRAVEL SIGNALS" : "LOGISTICS SIGNALS";
  const ranked = [...signals].sort(
    (a, b) => (b.inputs.confidence ?? 0) - (a.inputs.confidence ?? 0),
  );
  const tiles = ranked.slice(0, 3);
  return (
    <Pane
      id="signals"
      title={title}
      area="signals"
      meta={lastSampleAt ? `sample ${shortDate(lastSampleAt)}` : "no samples"}
      hints="j/k signals · z zoom"
      foot={
        <>
          <output>
            {sourceLabels(sources) || (layer === "air" ? "ADS-B · OpenSky" : "AISStream")}
          </output>
          <span className="right">rule signals · evidence-linked</span>
        </>
      }
    >
      {ranked.length ? (
        <>
          <div className="tiles">
            {tiles.map((s) => (
              <div key={s.kind} className="tile">
                <span className="lbl">{signalLabel(s.kind)}</span>
                <span className="val">{altValue(s.kind, s.value)}</span>
                <span className="sub">
                  {s.inputs.baseline
                    ? `vs ${num(s.inputs.baseline.mean, 1)} baseline`
                    : shortDate(s.asOf)}
                </span>
              </div>
            ))}
          </div>
          <CalloutGroup title="Reads" count={ranked.length}>
            {ranked.map((s, i) => (
              <Callout
                key={s.kind}
                tone={(s.inputs.confidence ?? 0) >= 0.45 ? "warn" : "neu"}
                title={
                  <span className="row">
                    <span className="muted">{String(i + 1).padStart(2, "0")} ·</span>
                    {signalLabel(s.kind)}
                    <span className="grow" />
                    {confidenceBadge(s.inputs.confidence)}
                  </span>
                }
                meta={`${altValue(s.kind, s.value)} · ${baselineText(s)} · ${s.inputs.evidence.length} evidence`}
              >
                {s.inputs.read}
              </Callout>
            ))}
          </CalloutGroup>
        </>
      ) : (
        <Empty
          title="No signals yet"
          hint={
            layer === "air" ? "ADS-B sampler · baseline window" : "AIS sampler · baseline window"
          }
        >
          Signals compute once enough {layer === "air" ? "flight legs" : "vessel calls"} are
          observed against a baseline.
        </Empty>
      )}
    </Pane>
  );
}

export function NoCoverage({
  id,
  title,
  area,
  layer,
  symbol,
}: {
  id: string;
  title: string;
  area: string;
  layer: "air" | "sea";
  symbol: string;
}) {
  return (
    <Pane id={id} title={title} area={area} meta="not covered">
      <Empty
        title={layer === "air" ? "No linked aircraft" : "No mapped facilities"}
        hint={layer === "air" ? "corporate_aircraft registry" : "facilities · facility_companies"}
      >
        {layer === "air"
          ? `${symbol} has no corporate aircraft in the registry, so there is no travel layer for it.`
          : `${symbol} has no geofenced ports, terminals or plants, so there is no logistics layer for it.`}
      </Empty>
    </Pane>
  );
}
