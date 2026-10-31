import { formatWhole } from "@/lib/money";
import { formatPct } from "@/lib/report/ratios";
import type { YearRow, YearTable } from "@/lib/report/year";

// The year-to-date table. First column sticks while the months scroll sideways; the YTD column is shaded and set off by a rule so it
// can't be mistaken for a month. Unlocked months say "draft" in their header.

function Cell({ row, v, ytd = false }: { row: YearRow; v: number | null; ytd?: boolean }) {
  const text = v === null ? (row.kind === "section" || row.kind === "group" ? "" : "-") : row.pct ? formatPct(v) : formatWhole(v);
  return <td className={`num yr-n ${ytd ? "yr-ytd" : ""}`}>{text}</td>;
}

export function YearTableView({ table }: { table: YearTable }) {
  const n = table.columns.length;
  return (
    <div className="yr-scroll" role="region" aria-label={`${table.year} profit and loss by month`} tabIndex={0}>
      <table className="yr">
        <thead>
          <tr>
            <th scope="col" className="yr-label">Line</th>
            {table.columns.map((c) => (
              <th key={c.month} scope="col" className="yr-n">
                {c.label}
                {c.draft ? <span className="yr-draft">draft</span> : null}
              </th>
            ))}
            <th scope="col" className="yr-n yr-ytd">YTD</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => {
            if (r.kind === "section" || r.kind === "group") {
              return (
                <tr key={r.key} className={`yr-${r.kind}`}>
                  <th scope="row" className="yr-label" colSpan={1}>{r.label}</th>
                  <td colSpan={n} />
                  <td className="yr-ytd" />
                </tr>
              );
            }
            return (
              <tr key={r.key} className={`yr-${r.kind} ${r.computed ? "yr-computed" : ""}`}>
                <th scope="row" className={`yr-label ${r.indent ? "yr-indent" : ""}`}>{r.label}</th>
                {r.cells.map((v, i) => <Cell key={i} row={r} v={v} />)}
                <Cell row={r} v={r.total} ytd />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
