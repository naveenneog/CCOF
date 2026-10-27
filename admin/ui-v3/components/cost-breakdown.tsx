import { useEffect, useRef, useState } from "react";
import { qs, useQuery } from "../lib/api.ts";
import { int, usd } from "../lib/format.ts";
import { href } from "../lib/router.ts";
import { isGroupId } from "../lib/groups.ts";
import { Button, CapabilityNotice, ChoiceInput, ErrorNote, Field, Loading } from "./ui.tsx";
import { Donut, HBars, topWithOther } from "./charts.tsx";
import type { DonutItem } from "./charts.tsx";
import { UserIdentity } from "./user-identity.tsx";
import { ScopeLink } from "./scope-link.tsx";

const ok = (cap: any) => cap && (cap.state === "available" || cap.state === "partial");
const money = (n: number | null) => usd(n);

function items(rows: any[], key: (r: any) => string, label: (r: any) => string = key): { items: DonutItem[]; unknown: number } {
  const all = rows.map((r) => ({ key: key(r), label: label(r), value: r.knownListUsd === null || r.knownListUsd === undefined ? null : Number(r.knownListUsd) }));
  return { items: all, unknown: all.filter((i) => i.value === null).length };
}

export function CostBreakdown({ refresh = 0 }: { refresh?: number }) {
  const [group, setGroup] = useState("");
  const [groupText, setGroupText] = useState("");
  const chooseGroup = (text: string) => {
    setGroupText(text);
    if (!text || isGroupId(text.trim())) setGroup(text.trim().toLowerCase());
  };
  const invalid = Boolean(groupText && !isGroupId(groupText.trim()));
  const scope = { period: "month", group };
  const groups = useQuery(`/api/v3/chargeback/groups${qs({ ...scope, limit: 200 })}`);
  const totals = useQuery(`/api/v3/chargeback/totals${qs(scope)}`);
  const users = useQuery(`/api/v3/chargeback/developers${qs({ ...scope, limit: 100 })}`);
  const models = useQuery(`/api/v3/chargeback/models${qs({ ...scope, limit: 50 })}`);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    [groups, totals, users, models].forEach((q) => q.reload());
  }, [refresh]);

  const groupRows: any[] = ok(groups.data) ? groups.data.data.rows : [];
  const groupOptions = groupRows.filter((r) => isGroupId(r.groupId)).map((r) => String(r.groupId));
  const total = ok(totals.data) ? totals.data.data.rows[0] : null;
  const main = items(groupRows, (r) => String(r.groupId), (r) => (r.groupNameSnapshots ?? [])[0] ?? String(r.groupId));
  const userSplit = items(ok(users.data) ? users.data.data.rows : [], (r) => String(r.person));
  const modelSplit = items(ok(models.data) ? models.data.data.rows : [], (r) => String(r.model));
  const scopeText = group || "all groups";

  return (
    <section className="panel breakdown" data-help="group-costs" aria-labelledby="breakdown-title">
      <div className="panel-head">
        <div><h2 id="breakdown-title">Month-to-date cost breakdown</h2>
          <p className="section-desc">Select a group to show its cost alone. The users and models split follows the selection.</p></div>
        <a className="btn btn-quiet btn-small" href={href(`/chargeback${qs({ group })}`)}>Open in chargeback</a>
      </div>
      <div className="breakdown-filters" role="group" aria-label="Breakdown filters">
        <Field label="Group" error={invalid ? "Object ID (GUID)" : null}>{(id, d) => <ChoiceInput id={id} describedBy={d} value={groupText} options={groupOptions} emptyLabel="All groups"
          invalid={invalid} onChange={chooseGroup} manualLabel="Enter a group ID…" />}</Field>
        {groupText && <Button variant="quiet" size="small" onClick={() => chooseGroup("")}>Clear</Button>}
      </div>
      <div className="breakdown-summary">
        <span className="breakdown-total" aria-live="polite">{total ? usd(total.knownListUsd) : totals.loading ? "…" : "—"}</span>
        <span className="hint">known list cost for {scopeText}{total?.listUsd === null && total?.knownListUsd !== null ? " · lower bound, some usage is unpriced" : ""}{total ? ` · ${int(total.requests)} requests` : ""}</span>
        {group && <ol className="crumbs" aria-label="Drill-down">
          <li><button type="button" onClick={() => chooseGroup("")}>All groups</button></li>
          <li><span aria-current="location">{group}</span></li>
        </ol>}
      </div>
      <div className="breakdown-grid">
        <div className="breakdown-main">
          <h3>{group || "By group"}</h3>
          {!groups.data && !groups.error ? <Loading chart /> : groups.error ? <ErrorNote error={groups.error} retry={groups.reload} />
            : !ok(groups.data) ? <CapabilityNotice cap={groups.data} what="Cost breakdown" />
              : main.items.length === 0 ? <p className="empty-inline">No usage observed for {scopeText} this month. That is no data, not zero cost.</p>
                : <Donut items={topWithOther(main.items)} format={money} label="Cost by group"
                  centerValue={usd(main.items.reduce((s, i) => s + (i.value ?? 0), 0), 0)} centerLabel={group ? "group" : "all groups"}
                  onSelect={(key) => { if (isGroupId(key)) chooseGroup(key.toLowerCase()); }} selected={group || undefined} unknownCount={main.unknown} />}
          {!group && main.items.length > 8 && <p className="hint">The top 7 groups are drawn; the rest are combined. Pick one from Group to see it alone.</p>}
          {group && <p className="hint"><ScopeLink id={group}>Open {group}</ScopeLink> for its budget, limits and models.</p>}
        </div>
        <div>
          <h3>Users</h3>
          {!users.data && !users.error ? <Loading rows={5} /> : users.error ? <ErrorNote error={users.error} retry={users.reload} />
            : !ok(users.data) ? <CapabilityNotice cap={users.data} what="Users split" />
              : userSplit.items.length === 0 ? <p className="empty-inline">No user activity for {scopeText}.</p>
                : <>
                  <HBars label={`Cost by user for ${scopeText}`} format={money}
                    items={userSplit.items.slice(0, 8).map((i) => ({ key: i.key, value: i.value,
                      label: <a href={href(`/chargeback${qs({ developer: i.key, group })}`)}><UserIdentity objectId={i.key} showPrincipalName={false} /></a> }))} />
                  <p className="hint">{int(userSplit.items.length)} user{userSplit.items.length === 1 ? "" : "s"}{userSplit.items.length > 8 ? ", top 8 shown" : ""}. Current Entra names are looked up separately; accounting and filters use object IDs.</p>
                </>}
        </div>
        <div>
          <h3>Models</h3>
          {!models.data && !models.error ? <Loading chart /> : models.error ? <ErrorNote error={models.error} retry={models.reload} />
            : !ok(models.data) ? <CapabilityNotice cap={models.data} what="Models split" />
              : modelSplit.items.length === 0 ? <p className="empty-inline">No model usage for {scopeText}.</p>
                : <Donut items={topWithOther(modelSplit.items, 5)} format={money} label={`Cost by model for ${scopeText}`} size={150}
                  centerValue={String(modelSplit.items.length)} centerLabel={modelSplit.items.length === 1 ? "model" : "models"} unknownCount={modelSplit.unknown} />}
        </div>
      </div>
      <p className="hint">Current month in UTC at list price, not an invoice. Groups with no telemetry are not shown; <a href={href("/groups")}>Groups lists every onboarded group</a>.</p>
    </section>
  );
}
