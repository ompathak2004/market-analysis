import { type CompanyBrief, type RuleInsight, type VerdictLabel, verdictLabelFor } from "@ma/intel";
import type { ReactNode } from "react";
import { Callout, CalloutGroup } from "@/components/ui/callout";
import { Badge, Chip } from "@/components/ui/chip";
import { EvidenceList, EvidenceRefs } from "@/components/ui/evidence";
import { Gauge } from "@/components/ui/gauge";
import { Pane } from "@/components/ui/pane";
import { getContext } from "@/server/context";
import { type CompanyBriefView, companyBrief } from "@/server/queries";
import { attempt, modelFoot, PaneError } from "../shared";

export const RULE_TONE: Record<RuleInsight["tone"], "pos" | "neg" | "neu"> = {
  positive: "pos",
  negative: "neg",
  neutral: "neu",
};

export function VerdictBlock({
  score,
  label,
  confidence,
  line,
  sub,
}: {
  score: number;
  label: VerdictLabel;
  confidence: number | null;
  line: string;
  sub: string;
}) {
  return (
    <div className="verdict">
      <Gauge score={score} label={label} confidence={confidence} />
      <div className="verdict-text">
        <span className="verdict-label" data-band={label}>
          {label}
        </span>
        <span className="read">{line}</span>
        <span className="dim sm">{sub}</span>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pane-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const SEVERITY_TONE = { low: "neu", medium: "warn", high: "neg" } as const;

type LoadedBrief = CompanyBriefView & {
  brief: CompanyBrief;
  meta: NonNullable<CompanyBriefView["meta"]>;
};

export function BriefBody({ view, full }: { view: LoadedBrief; full: boolean }) {
  const b = view.brief;
  const prev = view.previous;
  const delta = prev ? b.verdict.score - prev.score : null;
  return (
    <>
      <VerdictBlock
        score={b.verdict.score}
        label={b.verdict.label}
        confidence={b.verdict.confidence}
        line={b.verdict.oneLiner}
        sub={`confidence ${Math.round(b.verdict.confidence * 100)}% · ${view.evidence.length} sources`}
      />
      {b.whatChanged.length || prev ? (
        <Section title="What changed since last brief">
          <ul className="callouts">
            <Callout
              tone={delta == null ? "info" : delta > 0 ? "pos" : delta < 0 ? "neg" : "neu"}
              title={
                prev
                  ? `Score ${Math.round(prev.score)} → ${Math.round(b.verdict.score)}`
                  : "First brief"
              }
              row={false}
            >
              {b.whatChanged.join(" · ") || "No material change."}
            </Callout>
          </ul>
        </Section>
      ) : null}
      <Section title="Investment thesis">
        <ol className="bullets">
          {b.thesis.map((t, i) => (
            <li key={String(i)}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span>
                {t.point} <EvidenceRefs ids={t.evidence} />
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Key risks">
        <ul className="bullets">
          {b.risks.map((r, i) => (
            <li key={String(i)}>
              <span className={SEVERITY_TONE[r.severity]}>−</span>
              <span>
                {r.point} <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>{" "}
                <EvidenceRefs ids={r.evidence} />
              </span>
            </li>
          ))}
        </ul>
      </Section>
      {b.catalysts.length ? (
        <Section title="Catalysts">
          <ul className="bullets">
            {b.catalysts.map((c, i) => (
              <li key={String(i)}>
                <span>→</span>
                <span>
                  {c.when ? <b>{c.when} · </b> : null}
                  {c.point} <EvidenceRefs ids={c.evidence} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Valuation read">
        <p className="read">{b.valuation.read}</p>
        {full && b.valuation.vsPeers ? (
          <p className="read dim">vs peers: {b.valuation.vsPeers}</p>
        ) : null}
        {full && b.valuation.vsConsensus ? (
          <p className="read dim">vs consensus: {b.valuation.vsConsensus}</p>
        ) : null}
      </Section>
      {full ? (
        <>
          {b.supplyChain.read ? (
            <Section title="Supply chain">
              <p className="read">{b.supplyChain.read}</p>
            </Section>
          ) : null}
          {b.managementTravel.read ? (
            <Section title="Management travel">
              <p className="read">{b.managementTravel.read}</p>
            </Section>
          ) : null}
          {b.logistics.read ? (
            <Section title="Logistics">
              <p className="read">{b.logistics.read}</p>
            </Section>
          ) : null}
          {b.uncertainty.length ? (
            <Section title="Uncertainty">
              <ul className="bullets">
                {b.uncertainty.map((u, i) => (
                  <li key={String(i)}>
                    <span className="warn">?</span>
                    <span>{u}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      ) : view.evidence.length ? (
        <Section title="Evidence · open original">
          <EvidenceList items={view.evidence.slice(0, 6)} />
        </Section>
      ) : null}
    </>
  );
}

function ruleVerdict(pos: number, neg: number, total: number) {
  const score = Math.max(5, Math.min(95, Math.round(50 + (pos - neg) * 6)));
  return {
    score,
    label: verdictLabelFor(score),
    confidence: Math.min(0.6, 0.15 + total * 0.03),
  };
}

export function RuleBriefBody({ items }: { items: RuleInsight[] }) {
  const pos = items.filter((i) => i.tone === "positive");
  const neg = items.filter((i) => i.tone === "negative");
  const v = ruleVerdict(pos.length, neg.length, items.length);
  const line =
    pos.length || neg.length
      ? `${pos.length} supportive and ${neg.length} adverse observations across price, financials and research.`
      : "Not enough data for a read yet.";
  return (
    <>
      <VerdictBlock
        score={v.score}
        label={v.label}
        confidence={v.confidence}
        line={line}
        sub={`rule-based · ${items.length} observations`}
      />
      <div className="pane-section">
        <p className="fallback-note">rule-based read · LLM brief pending</p>
      </div>
      <CalloutGroup title="Supportive" count={pos.length}>
        {pos.slice(0, 4).map((i) => (
          <Callout key={i.id} tone="pos" row={false}>
            {i.text}
          </Callout>
        ))}
      </CalloutGroup>
      <CalloutGroup title="Adverse" count={neg.length}>
        {neg.slice(0, 4).map((i) => (
          <Callout key={i.id} tone="neg" row={false}>
            {i.text}
          </Callout>
        ))}
      </CalloutGroup>
    </>
  );
}

export async function BriefPane({
  symbol,
  full = false,
  area = "brief",
}: {
  symbol: string;
  full?: boolean;
  area?: string;
}) {
  const ctx = getContext();
  const res = await attempt(companyBrief(ctx, symbol));
  const title = "INTELLIGENCE BRIEF";
  if (!res.ok) return <PaneError id={area} title={title} area={area} code={res.code} />;
  const actions = full ? null : <Chip href={`/c/${encodeURIComponent(symbol)}/intl`}>INTL →</Chip>;
  const { brief, meta, ruleInsights } = res.data;
  if (brief && meta)
    return (
      <Pane
        id={area}
        title={title}
        area={area}
        meta={`${meta.generatedAt.slice(0, 10)}${meta.stale ? " · stale" : ""}`}
        actions={actions}
        foot={<output>{modelFoot(meta)}</output>}
      >
        <BriefBody view={{ ...res.data, brief, meta }} full={full} />
      </Pane>
    );
  return (
    <Pane
      id={area}
      title={title}
      area={area}
      meta="rule-based"
      actions={actions}
      foot={<output>rule-based read · LLM brief pending · gpt-oss-120b</output>}
    >
      <RuleBriefBody items={ruleInsights} />
    </Pane>
  );
}
