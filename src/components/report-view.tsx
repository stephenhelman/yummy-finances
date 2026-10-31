import { formatCents } from "@/lib/money";
import type { Report, ReportGroup, ReportLine } from "@/lib/report/pnl";
import { RATIO_LABELS, formatPct } from "@/lib/report/ratios";

// The accountant's P&L, laid out for a phone: label left, amount right. Used by the Reports page and the draft preview.

function Row({ line, indent = true, strong = false }: { line: Pick<ReportLine, "label" | "cents" | "count" | "computed">; indent?: boolean; strong?: boolean }) {
  return (
    <div className={`pl-row ${strong ? "pl-strong" : ""} ${indent ? "pl-indent" : ""} ${line.computed ? "pl-computed" : ""}`}>
      <span className="pl-label">{line.label}{line.computed && line.count ? <span className="small muted"> · {line.count} in review</span> : null}</span>
      <span className="num pl-amount">{formatCents(line.cents)}</span>
    </div>
  );
}

function Group({ group, totalLabel }: { group: ReportGroup; totalLabel?: string }) {
  return (
    <>
      {group.name ? <h3 className="pl-group">{group.name}</h3> : null}
      {group.lines.map((l) => <Row key={l.key} line={l} />)}
      {group.name ? <Row line={{ label: totalLabel ?? `Total ${group.name}`, cents: group.subtotalCents }} indent={false} strong /> : null}
    </>
  );
}

export function ReportView({ report }: { report: Report }) {
  const neg = (l: ReportLine) => (l.key === "sales-returns" || l.key === "discounts" ? { ...l, cents: -l.cents } : l);
  const top = report.expenses.groups.find((g) => g.name === null);
  return (
    <div className="stack-lg">
      <section className="card pl" aria-labelledby="rev-h">
        <h2 id="rev-h">Revenue</h2>
        {report.revenue.lines.map((l) => <Row key={l.key} line={neg(l)} />)}
        <Row line={{ label: "Gross Revenue", cents: report.revenue.grossRevenueCents }} indent={false} strong />
      </section>

      <section className="card pl" aria-labelledby="exp-h">
        <h2 id="exp-h">Expenses</h2>
        {top ? top.lines.map((l) => <Row key={l.key} line={l} />) : null}
        {report.expenses.groups.filter((g) => g.name !== null).map((g) => <Group key={g.name} group={g} />)}
        <Row line={{ label: "Total Expenses", cents: report.expenses.totalCents }} indent={false} strong />
        <div className="pl-net">
          <span>Net Income</span>
          <span className="num">{formatCents(report.netIncomeCents)}</span>
        </div>
      </section>

      <section className="card pl" aria-labelledby="below-h">
        <h2 id="below-h">Not part of profit and loss</h2>
        <p className="small muted">These don&rsquo;t change Net Income. Totals are shown so nothing goes missing.</p>
        {report.below.groups.map((g) => <Group key={g.name} group={g} />)}
        <Row line={report.below.uncategorized} indent={false} strong />
      </section>

      {report.ratios ? (
        <section className="card pl" aria-labelledby="ratios-h">
          <h2 id="ratios-h">Ratios</h2>
          <p className="small muted">Against net sales: after discounts and returns, before tax.</p>
          <Row line={{ label: "Net sales", cents: report.netSalesCents }} indent={false} strong />
          {(["laborPct", "productPct", "primePct", "rentPct"] as const).map((k) => (
            <div key={k} className="pl-row pl-indent"><span className="pl-label">{RATIO_LABELS[k]}</span><span className="num pl-amount">{formatPct(report.ratios[k])}</span></div>
          ))}
        </section>
      ) : null}

      <section className="card" aria-labelledby="notes-h">
        <h2 id="notes-h">Cash notes</h2>
        <ul className="notes">{report.cashNotes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    </div>
  );
}

export function ReportWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <section className="alert alert-warn" role="status" aria-label="Report warnings">
      <strong>{warnings.length === 1 ? "1 thing to look at" : `${warnings.length} things to look at`}</strong>
      {warnings.map((w) => <p key={w}>{w}</p>)}
    </section>
  );
}
