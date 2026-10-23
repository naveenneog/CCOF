import { useEffect, useState } from "react";
import { useQuery } from "../lib/api.ts";
import { token } from "../lib/auth.ts";
import { int, usd } from "../lib/format.ts";
import { groupEstimate, SURFACE_OPTIONS } from "../lib/groups.ts";
import type { GroupForm, Surface } from "../lib/groups.ts";
import { Button, Field, Section } from "./ui.tsx";
import { BudgetAssistant } from "./budget-assistant.tsx";
import { FAMILY_ORDER, LimitsEditor } from "./limits.tsx";
import type { FamilyPolicy } from "./limits.tsx";
import { applyPatch } from "../pages/project-detail.tsx";

type Set = (patch: Partial<GroupForm>) => void;
type Errors = Record<string, string>;

// Downloads an authenticated export (CSV) as a file; the API needs the bearer token, so a plain link cannot.
export async function downloadExport(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${await token()}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Export failed (${res.status}).`);
  const truncated = res.headers.get("x-ccof-truncated") === "true";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (truncated) throw new Error("The export reached the 5,000-row limit and is incomplete. Narrow the period or filters.");
}

const money = (amount: number, currency: "USD" | "CCU") => currency === "USD" ? usd(amount) : `${int(amount)} CCU`;

export function BudgetFields({ form, set, errors, members }: { form: GroupForm; set: Set; errors: Errors; members: number | null }) {
  const estimate = groupEstimate(form, members);
  return (
    <Section title="Budget" description="Each member gets the per-user budget every month. Auto-scale has no group total; a cap shares one monthly total across the group.">
      <div className="row-fields">
        <Field label="Per-user budget (monthly)" error={errors.perUserAmount}>{(id, d) => (
          <div className="input-group">
            <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.perUserAmount)} className="input input-num" inputMode="decimal" value={form.perUserAmount} onChange={(e) => set({ perUserAmount: e.target.value })} />
            <select className="input" aria-label="Budget unit" value={form.currency} onChange={(e) => set({ currency: e.target.value as "USD" | "CCU" })}><option>USD</option><option>CCU</option></select>
          </div>
        )}</Field>
        <fieldset className="fieldset">
          <legend>Group total</legend>
          <label className="check"><input type="radio" name="mode" checked={form.mode === "autoScale"} onChange={() => set({ mode: "autoScale" })} /> Auto-scale: grows with every member added</label>
          <label className="check"><input type="radio" name="mode" checked={form.mode === "cap"} onChange={() => set({ mode: "cap" })} /> Cap: a fixed monthly total for the whole group</label>
        </fieldset>
        {form.mode === "cap" && (
          <Field label={`Group cap (monthly, ${form.currency})`} error={errors.capAmount}>{(id, d) => (
            <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.capAmount)} className="input input-num" inputMode="decimal" value={form.capAmount} onChange={(e) => set({ capAmount: e.target.value })} />
          )}</Field>
        )}
      </div>
      {estimate ? (
        <p className="notice notice-info" role="status">
          {int(estimate.members)} direct member{estimate.members === 1 ? "" : "s"} × {money(estimate.perUser, estimate.currency)} = {money(estimate.uncapped, estimate.currency)} a month.
          {form.mode === "cap" ? (estimate.capBinds ? ` The cap limits the group to ${money(estimate.ceiling, estimate.currency)}; members may be refused before using their own budget.` : " The cap is above that total today.") : " Each new member adds one per-user budget."}
        </p>
      ) : <p className="hint">Member count unavailable: the estimate needs the group directory (ADMIN_GROUP_SEARCH_ENABLED).</p>}
    </Section>
  );
}

export function AccessFields({ form, set, errors }: { form: GroupForm; set: Set; errors: Errors }) {
  const toggle = (s: Surface) => set({ surfaces: form.surfaces.includes(s) ? form.surfaces.filter((x) => x !== s) : [...form.surfaces, s] });
  return (
    <Section title="Access" description="Which applications the group may use, its chargeback ID and its precedence.">
      <fieldset className="fieldset" aria-describedby={errors.surfaces ? "surfaces-error" : undefined}>
        <legend>Allowed surfaces</legend>
        {SURFACE_OPTIONS.map((o) => (
          <label key={o.value} className="check"><input type="checkbox" checked={form.surfaces.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}{o.note ? <span className="muted"> · {o.note}</span> : null}</label>
        ))}
        {errors.surfaces && <p className="field-error" id="surfaces-error" role="alert">{errors.surfaces}</p>}
      </fieldset>
      <div className="row-fields">
        <Field label="Chargeback ID" hint="Optional. For example a WBS element; shown per developer in chargeback and exports." error={errors.chargebackId}>{(id, d) => (
          <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.chargebackId)} className="input mono" value={form.chargebackId} maxLength={64} onChange={(e) => set({ chargebackId: e.target.value })} autoComplete="off" spellCheck={false} />
        )}</Field>
        <Field label="Priority" hint="When a person is in several groups and sends no project header, the group with the higher per-user budget applies; with equal budgets, the lower number." error={errors.priority}>{(id, d) => (
          <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.priority)} className="input input-num" inputMode="numeric" value={form.priority} onChange={(e) => set({ priority: e.target.value })} />
        )}</Field>
      </div>
    </Section>
  );
}

export function ModelFields({ form, set, errors }: { form: GroupForm; set: Set; errors: Errors }) {
  const policy = form.policy as unknown as FamilyPolicy;
  return (
    <Section title="Models and rate limits">
      <label className="check"><input type="checkbox" checked={form.restrictedFamiliesApproved} onChange={(e) => set({ restrictedFamiliesApproved: e.target.checked })} /> Restricted families (Fable, Mythos) are approved for this group</label>
      {errors.families && <p className="field-error" role="alert">{errors.families}</p>}
      <LimitsEditor policy={policy} classification="group" restrictedAllowed={form.restrictedFamiliesApproved} onChange={(p) => set({ policy: p as unknown as GroupForm["policy"] })} />
    </Section>
  );
}

// autoApply (onboarding): the suggestion fills the field until the admin types a value. Without it
// (an existing group), the stored value is kept and the suggestion is only offered.
export function CacheFields({ form, set, errors, autoApply = false, readOnly = false }: { form: GroupForm; set: Set; errors: Errors; autoApply?: boolean; readOnly?: boolean }) {
  const path = form.surfaces.length ? `/api/groups/cache-suggestion?surfaces=${form.surfaces.join(",")}` : null;
  const suggestion = useQuery<{ suggestion: { percent: number; from: { surface: string; basis: string }[] } | null }>(path);
  const s = suggestion.data?.suggestion ?? null;
  useEffect(() => { if (autoApply && !readOnly && s && form.cacheBasis === "suggested" && String(s.percent) !== form.cacheReadPercent) set({ cacheReadPercent: String(s.percent) }); }, [s?.percent, form.cacheBasis, autoApply, readOnly]);
  const differs = s !== null && String(s.percent) !== form.cacheReadPercent;
  return (
    <Section title="Expected cache reads" description="The share of input tokens expected to be read from the prompt cache. It shapes the budget assistant's estimate; it is not enforced.">
      <div className="row-fields">
        <Field label="Cache-read share of input (%)" error={errors.cacheReadPercent}
          hint={s ? `Suggested ${s.percent}% from ${s.from.map((f) => `${f.surface} (${f.basis})`).join(", ")}. Replace it with the group's observed value from chargeback when available.` : "No suggestion for these surfaces."}>{(id, d) => (
          <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.cacheReadPercent)} className="input input-num" inputMode="decimal" value={form.cacheReadPercent}
            onChange={(e) => set({ cacheReadPercent: e.target.value, cacheBasis: "custom" })} />
        )}</Field>
        {!readOnly && differs && s && (form.cacheBasis === "custom" || !autoApply) && <Button variant="quiet" size="small" onClick={() => set({ cacheReadPercent: String(s.percent), cacheBasis: "suggested" })}>Use suggestion ({s.percent}%)</Button>}
      </div>
    </Section>
  );
}

export function AssistantFields({ form, set }: { form: GroupForm; set: Set }) {
  const policy = form.policy as unknown as FamilyPolicy;
  const [note, setNote] = useState<string | null>(null);
  const perUser = Number(form.perUserAmount);
  const cap = Number(form.capAmount);
  return (
    <Section title="Budget assistant" description="Suggests quotas and TPM from the per-user budget and the expected cache reads; Apply fills the limits above for review.">
      {note && <p className="notice notice-info" role="status">{note}</p>}
      <BudgetAssistant key={Object.keys(policy.families).join()} families={FAMILY_ORDER.filter((f) => policy.families[f]).map((f) => ({ family: f, models: policy.families[f].models }))}
        initialBudget={{ amount: Number.isFinite(perUser) ? perUser : 0, currency: form.currency, period: "monthly" }}
        initialGroupBudget={form.mode === "cap" && Number.isFinite(cap) ? { amount: cap, currency: form.currency, period: "monthly" } : null}
        initialCacheReadPercent={Number(form.cacheReadPercent)} applyLabel="Apply to the group's limits"
        onApply={(patch, summary) => { set({ policy: applyPatch(policy, patch) as unknown as GroupForm["policy"] }); setNote(`Limits filled from the assistant (${summary}). Review before saving.`); }} />
    </Section>
  );
}
