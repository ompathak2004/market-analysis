import type { Span } from "@ma/agent";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pane } from "@/components/ui/pane";
import { BotStore } from "@/server/bot/store";
import { getContext } from "@/server/context";
import { hasAdminSession } from "@/server/http/admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Assistant traces · MA Terminal",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f-]{36}$/i;

function depthOf(span: Span, byId: Map<string, Span>): number {
  let d = 0;
  let p = span.parentId ? byId.get(span.parentId) : undefined;
  while (p && d < 6) {
    d++;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return d;
}

function attrLine(attrs: Span["attrs"]): string {
  return Object.entries(attrs)
    .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
    .map(
      ([k, v]) =>
        `${k.replace(/^(gen_ai|agent|bot)\./, "")}=${Array.isArray(v) ? v.join(",") : String(v)}`,
    )
    .join("  ");
}

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = getContext();
  if (!ctx.config.ADMIN_API_KEY) notFound();
  if (!(await hasAdminSession(ctx))) redirect("/admin/login");
  const params = await searchParams;
  const id = typeof params.id === "string" && UUID.test(params.id) ? params.id : null;
  const store = new BotStore(ctx.redis);
  const [recent, trace] = await Promise.all([store.recentTraces(100), id ? store.trace(id) : null]);
  const total = trace?.durationMs ?? 1;
  const byId = new Map((trace?.spans ?? []).map((s) => [s.id, s]));
  return (
    <div className="grid grid-signals-one">
      <Pane
        id="trace"
        title={trace ? `Trace ${trace.traceId.slice(0, 8)}` : "Trace"}
        meta={trace ? `${trace.durationMs} ms · ${trace.startedAt}` : "select a trace"}
        hints=""
      >
        {trace ? (
          <div className="trace-view">
            <pre className="trace-attrs">{attrLine(trace.attrs)}</pre>
            <table className="dt trace-spans">
              <thead>
                <tr>
                  <th>Span</th>
                  <th>Timeline</th>
                  <th>ms</th>
                  <th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {trace.spans.map((s) => (
                  <tr key={s.id} data-status={s.status}>
                    <td style={{ paddingLeft: 8 + depthOf(s, byId) * 12 }}>{s.name}</td>
                    <td>
                      <span className="trace-bar">
                        <i
                          style={{
                            left: `${(s.startMs / total) * 100}%`,
                            width: `${Math.max(0.5, (((s.endMs ?? s.startMs) - s.startMs) / total) * 100)}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td>{(s.endMs ?? s.startMs) - s.startMs}</td>
                    <td className="trace-attr-cell" title={attrLine(s.attrs)}>
                      {attrLine(s.attrs)}
                      {s.events.map((e) => ` · ${e.name}: ${attrLine(e.attrs)}`).join("")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted trace-empty">
            {id ? "Trace expired or unknown." : "Pick a trace from the list."}
          </p>
        )}
      </Pane>
      <Pane id="traces" title="Recent assistant turns" meta={`${recent.length}`} hints="">
        <table className="dt">
          <tbody>
            {recent.map((r) => (
              <tr key={r.traceId} data-status={r.status}>
                <td>
                  <Link href={`/admin/traces?id=${r.traceId}`}>
                    {r.at.slice(5, 19).replace("T", " ")}
                  </Link>
                </td>
                <td>{r.status}</td>
                <td>{r.failure ?? ""}</td>
                <td>{r.durationMs ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Pane>
    </div>
  );
}
