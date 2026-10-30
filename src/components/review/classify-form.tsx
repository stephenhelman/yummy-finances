import { classifyAction } from "@/app/admin/review/actions";
import { PICKABLE_SECTIONS, moreKindsFor, picksFor, type CategoryOption } from "@/lib/review/choices";
import type { TxnView } from "@/lib/review/view";
import { extractZelleCounterparty } from "@/lib/rules/zelle";

const SECTION_LABEL: Record<string, string> = { COGS: "Cost of goods", OPEX: "Operating expenses", OTHER: "Other" };

/** Who "Always do this for…" is about: the person for Zelle, otherwise the merchant. */
function alwaysTarget(txn: TxnView): string {
  const cp = extractZelleCounterparty(txn.raw);
  return cp ? cp.name.replace(/\b(\w)(\w*)/g, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase()) : txn.merchant;
}

/**
 * The shared classify controls (Review card and the Transactions edit sheet). One form: each button posts its choice,
 * and the "Always" checkbox rides along, so it must be set before tapping a choice.
 */
export function ClassifyForm({ txn, categories, returnTo }: { txn: TxnView; categories: CategoryOption[]; returnTo: string }) {
  const picks = picksFor(txn.amountCents);
  const kinds = moreKindsFor(txn.amountCents);
  const groups = ["COGS", "OPEX", "OTHER"].map((s) => ({ section: s, items: categories.filter((c) => c.section === s && PICKABLE_SECTIONS.has(c.section)) })).filter((g) => g.items.length);

  return (
    <form action={classifyAction} className="stack">
      <input type="hidden" name="txnId" value={txn.id} />
      <input type="hidden" name="returnTo" value={returnTo} />

      <div className="picks" role="group" aria-label="Choose what this is">
        {picks.map((p) => (
          <button key={p.id} type="submit" name="choice" value={`pick:${p.id}`} className="btn btn-secondary pick">
            {p.label}
          </button>
        ))}
      </div>

      {txn.isCheck ? (
        <p className="small muted">Checks have no payee, so this applies to this check only.</p>
      ) : (
        <label className="toggle">
          <input type="checkbox" name="always" value="1" />
          <span>
            Always do this for <strong>{alwaysTarget(txn)}</strong>
          </span>
        </label>
      )}

      <details className="more">
        <summary className="btn btn-secondary btn-block">More…</summary>
        <div className="stack more-body">
          <div className="field">
            <label htmlFor={`cat-${txn.id}`}>Category</label>
            <select id={`cat-${txn.id}`} name="category" className="input" defaultValue="">
              <option value="" disabled>Choose a category</option>
              {groups.map((g) => (
                <optgroup key={g.section} label={SECTION_LABEL[g.section] ?? g.section}>
                  {g.items.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="submit" name="choice" value="more:category" className="btn btn-primary">Use this category</button>
          </div>
          <div className="stack">
            <p className="small muted">Not part of profit and loss</p>
            <div className="picks">
              {kinds.map((k) => (
                <button key={k.kind} type="submit" name="choice" value={`kind:${k.kind}`} className="btn btn-secondary pick">
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>
    </form>
  );
}
