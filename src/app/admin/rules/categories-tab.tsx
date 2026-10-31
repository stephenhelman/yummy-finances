import { formatCents } from "@/lib/money";
import { db } from "@/lib/db";
import { NON_PL_KIND_CHOICES, TREATMENT_LABEL } from "@/lib/review/category-rules";
import { previewMerge } from "@/lib/review/category-admin";
import type { CategoryOption } from "@/lib/review/choices";
import { loadCategories, loadCategoryStats, loadGroups, type CategoryStat } from "@/lib/review/queries";
import {
  addCategoryAction, addGroupAction, archiveCategoryAction, mergeCategoryAction, moveCategoryAction, quickPickAction, renameCategoryAction, renameGroupAction, reorderCategoryAction,
  reorderGroupAction, restoreCategoryAction, showWhenZeroAction,
} from "./category-actions";

const BACK = "/admin/rules?tab=categories";
const Hidden = ({ id }: { id?: string }) => (
  <>
    {id ? <input type="hidden" name="id" value={id} /> : null}
    <input type="hidden" name="returnTo" value={BACK} />
  </>
);

function Arrow({ action, id, dir, label }: { action: (f: FormData) => Promise<void>; id: string; dir: "up" | "down"; label: string }) {
  return (
    <form action={action}>
      <Hidden id={id} />
      <input type="hidden" name="dir" value={dir} />
      <button type="submit" className="btn btn-ghost btn-sm icon-btn" aria-label={label}>{dir === "up" ? "↑" : "↓"}</button>
    </form>
  );
}

export async function CategoriesTab({ businessId, year, merge }: { businessId: string; year: string; merge: string | undefined }) {
  const [cats, groups, stats] = await Promise.all([loadCategories(db, businessId), loadGroups(db, businessId), loadCategoryStats(db, businessId, year)]);
  const active = cats.filter((c) => !c.archived);
  const archived = cats.filter((c) => c.archived);
  const picks = active.filter((c) => c.quickPickOrder !== null).sort((a, b) => a.quickPickOrder! - b.quickPickOrder!);

  // optional merge confirmation: ?merge=<fromId>:<toId>
  let mergeCard: React.ReactNode = null;
  if (merge) {
    const [fromId, toId] = merge.split(":");
    const p = await previewMerge(db, businessId, fromId ?? "", toId ?? "");
    mergeCard = p.ok ? (
      <section className="card" aria-label="Confirm merge">
        <h2>Merge &ldquo;{p.plan.fromName}&rdquo; into &ldquo;{p.plan.toName}&rdquo;?</h2>
        <ul className="notes">
          <li><strong className="num">{p.plan.transactionsOpen}</strong> transaction{p.plan.transactionsOpen === 1 ? "" : "s"} in open months will move.</li>
          <li><strong className="num">{p.plan.rules}</strong> rule{p.plan.rules === 1 ? "" : "s"} will move.</li>
          <li><strong className="num">{p.plan.transactionsLocked}</strong> transaction{p.plan.transactionsLocked === 1 ? "" : "s"} in locked months stay as they are, and locked reports don&rsquo;t change.</li>
          <li>&ldquo;{p.plan.fromName}&rdquo; is archived afterwards (it can be restored).</li>
        </ul>
        <form action={mergeCategoryAction} className="row">
          <Hidden />
          <input type="hidden" name="fromId" value={fromId} />
          <input type="hidden" name="toId" value={toId} />
          <button type="submit" className="btn btn-primary">Merge</button>
          <a href={BACK} className="btn btn-ghost">Cancel</a>
        </form>
      </section>
    ) : (
      <p className="alert alert-bad" role="alert">{p.error}</p>
    );
  }

  const top = active.filter((c) => c.groupName === null);
  const byGroup = groups.map((g) => ({ g, items: active.filter((c) => c.groupName === g.name) })).filter((x) => x.items.length);

  return (
    <>
      {mergeCard}
      <p className="muted">This is the report, in order. Every line shows every month, even at $0, unless you turn that off. Counts and dollars are for {year}.</p>

      <section className="card" aria-labelledby="picks-h">
        <h2 id="picks-h">Review quick picks</h2>
        <p className="small muted">The big buttons on the Review screen, in this order (up to 6). Everything else is under More…</p>
        {picks.length ? (
          <ol className="pick-list">
            {picks.map((c, i) => (
              <li key={c.id}>
                <span>{c.name}</span>
                <span className="row">
                  {i > 0 ? <PickBtn id={c.id} op="up" label={`Move ${c.name} up`}>↑</PickBtn> : null}
                  {i < picks.length - 1 ? <PickBtn id={c.id} op="down" label={`Move ${c.name} down`}>↓</PickBtn> : null}
                  <PickBtn id={c.id} op="remove" label={`Remove ${c.name} from quick picks`}>Remove</PickBtn>
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="muted">None. Add some from the list below.</p>}
      </section>

      <Rows title="Revenue and top-level lines" items={top} stats={stats} groups={groups} cats={cats} />
      {byGroup.map(({ g, items }, i) => (
        <section key={g.id} className="stack">
          <div className="row-between">
            <h2 className="section-title">{g.name}</h2>
            <div className="row">
              {i > 0 ? <Arrow action={reorderGroupAction} id={g.id} dir="up" label={`Move group ${g.name} up`} /> : null}
              {i < byGroup.length - 1 ? <Arrow action={reorderGroupAction} id={g.id} dir="down" label={`Move group ${g.name} down`} /> : null}
            </div>
          </div>
          <details className="more">
            <summary className="btn btn-ghost btn-sm">Rename group</summary>
            <form action={renameGroupAction} className="field more-body">
              <Hidden id={g.id} />
              <label htmlFor={`g-${g.id}`}>Group name</label>
              <input id={`g-${g.id}`} name="name" className="input" defaultValue={g.name} />
              <button type="submit" className="btn btn-primary">Save</button>
            </form>
          </details>
          <Rows items={items} stats={stats} groups={groups} cats={cats} />
        </section>
      ))}

      <section className="card" aria-labelledby="add-h">
        <h2 id="add-h">Add a category</h2>
        <form action={addCategoryAction} className="stack">
          <Hidden />
          <div className="field"><label htmlFor="n-name">Name</label><input id="n-name" name="name" className="input" required maxLength={80} /></div>
          <div className="field">
            <label htmlFor="n-treat">What is it?</label>
            <select id="n-treat" name="treatment" className="input" defaultValue="PNL_EXPENSE">
              <option value="PNL_EXPENSE">Expense (reduces Net Income)</option>
              <option value="PNL_INCOME">Income (adds to Net Income)</option>
              <option value="NON_PL">Not in profit and loss</option>
              <option value="PERSONAL">Personal</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="n-kind">If not in profit and loss, what kind of money?</label>
            <select id="n-kind" name="nonPlKind" className="input" defaultValue="">
              <option value="">Not applicable</option>
              {NON_PL_KIND_CHOICES.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="n-group">Group</label>
            <select id="n-group" name="groupId" className="input" defaultValue="">
              <option value="">Top-level line (no group)</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">Add category</button>
        </form>
        <details className="more">
          <summary className="btn btn-ghost btn-sm">Add a group</summary>
          <form action={addGroupAction} className="field more-body">
            <Hidden />
            <label htmlFor="g-new">Group name</label>
            <input id="g-new" name="name" className="input" maxLength={60} />
            <button type="submit" className="btn btn-secondary">Add group</button>
          </form>
        </details>
      </section>

      {archived.length ? (
        <details className="more">
          <summary className="btn btn-secondary btn-block">Archived ({archived.length})</summary>
          <ul className="list more-body">
            {archived.map((c) => (
              <li key={c.id}>
                <div className="grow"><span>{c.name}</span> <StatLine stat={stats.get(c.id)} /></div>
                <form action={restoreCategoryAction}><Hidden id={c.id} /><button type="submit" className="btn btn-ghost btn-sm">Restore</button></form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function PickBtn({ id, op, label, children }: { id: string; op: "up" | "down" | "remove" | "add"; label: string; children: React.ReactNode }) {
  return (
    <form action={quickPickAction}>
      <Hidden id={id} />
      <input type="hidden" name="op" value={op} />
      <button type="submit" className="btn btn-ghost btn-sm" aria-label={label}>{children}</button>
    </form>
  );
}

function StatLine({ stat }: { stat: CategoryStat | undefined }) {
  return <span className="small muted num">{stat ? `${stat.count} · ${formatCents(Math.abs(stat.cents))}` : "0 · $0.00"}</span>;
}

function Rows({ title, items, stats, groups, cats }: { title?: string; items: CategoryOption[]; stats: Map<string, CategoryStat>; groups: { id: string; name: string }[]; cats: CategoryOption[] }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="stack">
      {title ? <h2 className="section-title">{title}</h2> : null}
      <ul className="txn-list cat-list">
        {sorted.map((c, i) => (
          <li key={c.id}>
            <details className="cat">
              <summary className="cat-row">
                <span className="txn-main">
                  <span className="txn-merchant">{c.name}</span>
                  <span className="small muted"><StatLine stat={stats.get(c.id)} /></span>
                </span>
                <span className="txn-side">
                  <span className="chip">{TREATMENT_LABEL[c.treatment]}</span>
                  {c.quickPickOrder !== null ? <span className="chip chip-warn">Quick pick</span> : null}
                  {!c.showWhenZero ? <span className="chip chip-neutral">Hidden at $0</span> : null}
                </span>
              </summary>
              <div className="stack cat-body">
                <div className="row">
                  {i > 0 ? <Arrow action={reorderCategoryAction} id={c.id} dir="up" label={`Move ${c.name} up`} /> : null}
                  {i < sorted.length - 1 ? <Arrow action={reorderCategoryAction} id={c.id} dir="down" label={`Move ${c.name} down`} /> : null}
                  {c.quickPickOrder === null ? <PickBtn id={c.id} op="add" label={`Make ${c.name} a quick pick`}>Make quick pick</PickBtn> : null}
                  <form action={showWhenZeroAction}>
                    <Hidden id={c.id} />
                    <input type="hidden" name="value" value={c.showWhenZero ? "0" : "1"} />
                    <button type="submit" className="btn btn-ghost btn-sm">{c.showWhenZero ? "Hide when $0" : "Show when $0"}</button>
                  </form>
                </div>
                <form action={renameCategoryAction} className="field">
                  <Hidden id={c.id} />
                  <label htmlFor={`r-${c.id}`}>Name</label>
                  <input id={`r-${c.id}`} name="name" className="input" defaultValue={c.name} maxLength={80} />
                  <button type="submit" className="btn btn-secondary">Rename</button>
                </form>
                <form action={moveCategoryAction} className="field">
                  <Hidden id={c.id} />
                  <label htmlFor={`m-${c.id}`}>Group</label>
                  <select id={`m-${c.id}`} name="groupId" className="input" defaultValue={groups.find((g) => g.name === c.groupName)?.id ?? ""}>
                    {c.treatment === "PNL_EXPENSE" || c.treatment === "PNL_INCOME" ? <option value="">Top-level line (no group)</option> : null}
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <button type="submit" className="btn btn-secondary">Move</button>
                </form>
                <form method="get" action="/admin/rules" className="field">
                  <input type="hidden" name="tab" value="categories" />
                  <input type="hidden" name="mergeFrom" value={c.id} />
                  <label htmlFor={`x-${c.id}`}>Merge into another category</label>
                  <select id={`x-${c.id}`} name="mergeTo" className="input" defaultValue="" required>
                    <option value="" disabled>Choose where it goes</option>
                    {cats.filter((o) => !o.archived && o.id !== c.id && o.treatment === c.treatment && o.nonPlKind === c.nonPlKind).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <button type="submit" className="btn btn-secondary">Preview merge</button>
                </form>
                {!c.key ? (
                  <form action={archiveCategoryAction}>
                    <Hidden id={c.id} />
                    <button type="submit" className="btn btn-ghost btn-sm">Archive (only if unused)</button>
                  </form>
                ) : <p className="small muted">The report itself uses this line, so it can&rsquo;t be archived. You can merge or rename it.</p>}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
