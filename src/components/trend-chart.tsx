import { formatCents } from "@/lib/money";
import type { TrendSeries } from "@/lib/report/year";

// A small server-rendered line chart (no chart library): months across, dollars up. Each series has its own colour AND line style
// (solid or dotted) and is labelled in a legend and at its last point, so it never relies on colour alone. The numbers are all in
// the table below it.

const W = 340, H = 210, L = 44, R = 16, T = 12, B = 26;
const STYLE: Record<string, { color: string; dash?: string }> = {
  netSales: { color: "var(--accent)" },
  expenses: { color: "var(--ink-2)" },
  net: { color: "var(--ok)" },
  lastYear: { color: "var(--ink-2)", dash: "2 5" },
};

/** Round the axis out to 1 / 2 / 5 × 10^n steps. */
function niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  const span = Math.max(max - min, 1);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

const short = (c: number) => {
  const d = c / 100;
  return Math.abs(d) >= 1000 ? `${d < 0 ? "-" : ""}$${(Math.abs(d) / 1000).toFixed(Math.abs(d) >= 10_000 ? 0 : 1)}k` : `${d < 0 ? "-" : ""}$${Math.abs(Math.round(d))}`;
};

export function TrendChart({ labels, series, title }: { labels: string[]; series: TrendSeries[]; title: string }) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!all.length) return <p className="muted">No data yet.</p>;
  const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const x = (i: number) => L + (i * (W - L - R)) / (labels.length - 1);
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo);

  const path = (s: TrendSeries) => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const summary = series.map((s) => {
    const last = [...s.values].reverse().find((v) => v !== null);
    return `${s.label}: ${last === undefined ? "no data" : `latest ${formatCents(last)}`}`;
  }).join("; ");

  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${summary}`} className="trend-svg">
        <title>{title}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? "trend-zero" : "trend-grid"} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" className="trend-tick">{short(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % 2 === 0 || labels.length <= 6 ? <text key={l} x={x(i)} y={H - 8} textAnchor="middle" className="trend-tick">{l}</text> : null))}
        {series.map((s) => {
          const st = STYLE[s.key] ?? { color: "var(--ink)" };
          const pts = s.values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
          return (
            <g key={s.key}>
              <path d={path(s)} fill="none" stroke={st.color} strokeWidth={s.dotted ? 2 : 2.25} strokeDasharray={st.dash} strokeLinecap="round" strokeLinejoin="round" />
              {s.dotted ? null : pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={2.5} fill={st.color} />)}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <ul className="trend-legend">
          {series.map((s) => {
            const st = STYLE[s.key] ?? { color: "var(--ink)" };
            return (
              <li key={s.key}>
                <svg width="28" height="8" aria-hidden="true"><line x1="1" x2="27" y1="4" y2="4" stroke={st.color} strokeWidth="2.5" strokeDasharray={st.dash} strokeLinecap="round" /></svg>
                {s.label}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
