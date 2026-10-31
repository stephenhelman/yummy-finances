import { classifyAction } from "@/app/admin/review/actions";
import { pickableGroups, quickPicks, type CategoryOption } from "@/lib/review/choices";
import type { TxnView } from "@/lib/review/view";
import { extractZelleCounterparty } from "@/lib/rules/zelle";

/** Who "Always do this for…" is about: the person for Zelle, otherwise the merchant. */
function alwaysTarget(txn: TxnView): string {
  const cp = extractZelleCounterparty(txn.raw);
  return cp ? cp.name.replace(/\b(\w)(\w*)/g, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase()) : txn.merchant;
}

/**
 * The shared classify controls (Review card and the Transactions edit sheet). The owner only ever picks a category; the
 * quick picks are configurable (Rules → Categories). One form: each button posts its category, and the "Always" checkbox
 * rides along, so it must be set before tapping a choice.
 */
export function ClassifyForm({ txn, categories, returnTo }: { txn: TxnView; categories: CategoryOption[]; returnTo: string }) {
  const picks = quickPicks(categories, txn.amountCents);
  const groups = pickableGroups(categories, txn.amountCents);

  return (
    <form action={classifyAction} className="stack">
      <input type="hidden" name="txnId" value={txn.id} />
      <input type="hidden" name="returnTo" value={returnTo} />

      {picks.length ? (
        <div className="picks" role="group" aria-label="Choose a category">
          {picks.map((p) => (
            <button key={p.id} type="submit" name="choice" value={`cat:${p.id}`} className="btn btn-secondary pick">
              {p.label}
            </button>
          ))}
        </div>
      ) : null}

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
        <div className="field more-body">
          <label htmlFor={`cat-${txn.id}`}>Category</label>
          <select id={`cat-${txn.id}`} name="category" className="input" defaultValue="">
            <option value="" disabled>Choose a category</option>
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="submit" name="choice" value="more:category" className="btn btn-primary">Use this category</button>
        </div>
      </details>
    </form>
  );
}
