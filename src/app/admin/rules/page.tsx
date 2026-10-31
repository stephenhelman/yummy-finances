import type { Metadata } from "next";
import Link from "next/link";
import { Notice, PendingNotice } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { CategoriesTab } from "./categories-tab";
import { db } from "@/lib/db";
import { pickableGroups, type CategoryOption } from "@/lib/review/choices";
import { classificationIsReady } from "@/lib/review/gate";
import { loadCategories, loadPeople, loadRuleViews, type PersonView, type RuleView } from "@/lib/review/queries";
import { kindLabel } from "@/lib/review/view";
import { formatCents } from "@/lib/money";
import { changeRuleAction, confirmRuleAction, labelRecipientAction, setRuleActiveAction } from "./actions";

export const metadata: Metadata = { title: "Rules" };

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function RulesPage({ searchParams }: { searchParams: Params }) {
  await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;
  const t = one(sp.tab);
  const tab = t === "people" ? "people" : t === "categories" ? "categories" : "rules";

  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>Rules</h1>
        <PendingNotice />
      </>
    );
  }
  const categories = await loadCategories(db, business.id);

  return (
    <>
      <h1>Rules</h1>
      <nav className="tabs" aria-label="Rules sections">
        <Link href="/admin/rules" aria-current={tab === "rules" ? "page" : undefined}>Rules</Link>
        <Link href="/admin/rules?tab=people" aria-current={tab === "people" ? "page" : undefined}>People</Link>
        <Link href="/admin/rules?tab=categories" aria-current={tab === "categories" ? "page" : undefined}>Categories</Link>
      </nav>
      <Notice notice={one(sp.notice)} error={one(sp.error)} />
      {tab === "rules" ? <RulesTab show={one(sp.show)} categories={categories} businessId={business.id} /> : null}
      {tab === "people" ? <PeopleTab categories={categories} businessId={business.id} /> : null}
      {tab === "categories" ? <CategoriesTab businessId={business.id} year={currentMonth(new Date(), business.timezone).slice(0, 4)} merge={one(sp.mergeFrom) && one(sp.mergeTo) ? `${one(sp.mergeFrom)}:${one(sp.mergeTo)}` : undefined} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

async function RulesTab({ show, categories, businessId }: { show: string | undefined; categories: CategoryOption[]; businessId: string }) {
  const all = await loadRuleViews(db, businessId);
  const counts = { all: all.length, unconfirmed: all.filter((r) => r.active && !r.confirmed).length, off: all.filter((r) => !r.active).length };
  const rules = show === "unconfirmed" ? all.filter((r) => r.active && !r.confirmed) : show === "off" ? all.filter((r) => !r.active) : all;
  const returnTo = `/admin/rules${show ? `?show=${show}` : ""}`;

  return (
    <>
      <nav className="chips" aria-label="Filter rules">
        <Link href="/admin/rules" className="chip-link" aria-current={!show ? "page" : undefined}>All <span className="num">{counts.all}</span></Link>
        <Link href="/admin/rules?show=unconfirmed" className="chip-link" aria-current={show === "unconfirmed" ? "page" : undefined}>Unconfirmed <span className="num">{counts.unconfirmed}</span></Link>
        <Link href="/admin/rules?show=off" className="chip-link" aria-current={show === "off" ? "page" : undefined}>Off <span className="num">{counts.off}</span></Link>
      </nav>
      {rules.length ? rules.map((r) => <RuleCard key={r.id} rule={r} categories={categories} returnTo={returnTo} />) : <section className="card"><p className="muted">No rules here.</p></section>}
    </>
  );
}

function RuleCard({ rule, categories, returnTo }: { rule: RuleView; categories: CategoryOption[]; returnTo: string }) {
  const what = rule.categoryName ?? kindLabel(rule.kind);
  const dir = rule.direction === "OUT" ? "Money out" : rule.direction === "IN" ? "Money in" : "Either direction";
  return (
    <section className={`card ${rule.active ? "" : "card-off"}`} aria-label={rule.name}>
      <div className="row-between">
        <h2 className="rule-name">{rule.name}</h2>
        <span className={`badge ${!rule.active ? "badge-neutral" : rule.confirmed ? "badge-ok" : "badge-warn"}`}>{!rule.active ? "Off" : rule.confirmed ? "Confirmed" : "Unconfirmed"}</span>
      </div>
      <p className="small muted">{dir} → <strong>{what}</strong> · {rule.source === "SEED" ? "Built in" : "Yours"}</p>
      <p className="small"><span className="num">{rule.matches}</span> {rule.matches === 1 ? "match" : "matches"} · <span className="num">{formatCents(rule.totalCents)}</span></p>

      <div className="row">
        {rule.active && !rule.confirmed ? (
          <form action={confirmRuleAction}>
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" className="btn btn-primary btn-sm">Confirm</button>
          </form>
        ) : null}
        <form action={setRuleActiveAction}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <input type="hidden" name="active" value={rule.active ? "0" : "1"} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit" className="btn btn-secondary btn-sm">{rule.active ? "Turn off" : "Turn on"}</button>
        </form>
      </div>

      {rule.active ? (
        <details className="more">
          <summary className="btn btn-ghost btn-sm">Change what it does</summary>
          <form action={changeRuleAction} className="stack more-body">
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="field">
              <label htmlFor={`c-${rule.id}`}>Category</label>
              <select id={`c-${rule.id}`} name="category" className="input" defaultValue="">
                <option value="" disabled>Choose a category</option>
                {pickableGroups(categories, rule.direction === "IN" ? -1 : 1).map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <button type="submit" name="choice" value="more:category" className="btn btn-primary">Use this category</button>
            </div>
            {rule.source === "SEED" ? <p className="small muted">This is a built-in rule. Your change is saved as your own rule and the built-in one is turned off.</p> : null}
          </form>
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

async function PeopleTab({ categories, businessId }: { categories: CategoryOption[]; businessId: string }) {
  const { to, from } = await loadPeople(db, businessId);
  const rank = (xs: PersonView[]) => [...xs].sort((a, b) => Number(!!a.current) - Number(!!b.current)); // unlabeled first, then by total
  return (
    <>
      <p className="muted">Zelle payments say who was paid but not why. Label each person once and every payment to them is sorted.</p>
      <h2 className="section-title">Paid to</h2>
      {to.length ? rank(to).map((p) => <PersonCard key={`to-${p.key}`} person={p} categories={categories} direction="to" />) : <section className="card"><p className="muted">No Zelle payments yet.</p></section>}
      <h2 className="section-title">Received from</h2>
      {from.length ? rank(from).map((p) => <PersonCard key={`from-${p.key}`} person={p} categories={categories} direction="from" />) : <section className="card"><p className="muted">None.</p></section>}
    </>
  );
}

const LABEL_TEXT = { STAFF: "Staff (wages)", FAMILY: "Family (personal)", VENDOR: "Vendor" } as const;

function PersonCard({ person: p, categories, direction }: { person: PersonView; categories: CategoryOption[]; direction: "to" | "from" }) {
  const returnTo = "/admin/rules?tab=people";
  const id = `${direction}-${p.key}`;
  return (
    <section className="card" aria-label={p.name}>
      <div className="row-between">
        <h3 className="rule-name">{p.name}</h3>
        {p.current ? <span className="badge badge-ok">{LABEL_TEXT[p.current.label]}{p.current.label === "VENDOR" && p.current.categoryName ? `: ${p.current.categoryName}` : ""}</span> : <span className="badge badge-warn">Not labeled</span>}
      </div>
      <p className="small"><span className="num">{p.count}</span> {p.count === 1 ? "payment" : "payments"} · <span className="num">{formatCents(p.totalCents)}</span> total · median <span className="num">{formatCents(p.medianCents)}</span></p>
      <p className="small muted">{p.cadence.hint}</p>
      <form action={labelRecipientAction} className="stack">
        <input type="hidden" name="name" value={p.name} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div className={`picks ${direction === "to" ? "picks-3" : ""}`}>
          {direction === "to" ? <button type="submit" name="label" value="STAFF" className="btn btn-secondary pick">Staff</button> : null}
          <button type="submit" name="label" value="FAMILY" className="btn btn-secondary pick">Family</button>
          <button type="submit" name="label" value="OTHER" className="btn btn-secondary pick">Other</button>
        </div>
        <details className="more">
          <summary className="btn btn-ghost btn-sm">Vendor…</summary>
          <div className="field more-body">
            <label htmlFor={`v-${id}`}>Which category?</label>
            <select id={`v-${id}`} name="category" className="input" defaultValue="">
              <option value="" disabled>Choose a category</option>
              {categories.filter((c) => c.treatment === "PNL_EXPENSE" && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="submit" name="label" value="VENDOR" className="btn btn-primary">Label as vendor</button>
          </div>
        </details>
      </form>
    </section>
  );
}
