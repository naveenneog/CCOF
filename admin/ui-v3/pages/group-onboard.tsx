import { useRef, useState } from "react";
import { api, errorMessage, useQuery } from "../lib/api.ts";
import { href, navigate } from "../lib/router.ts";
import { clearErrors, emptyGroupForm, formProblems, formToBody } from "../lib/groups.ts";
import type { GroupForm } from "../lib/groups.ts";
import { Button, ChoiceInput, Empty, ErrorNote, Field, PageHeader, Section, useToast } from "../components/ui.tsx";
import { AccessFields, AssistantFields, BudgetFields, CacheFields, ModelFields } from "../components/group-fields.tsx";
import { useSession } from "../components/shell.tsx";

const STEPS = ["Find the group", "Budget", "Access and models", "Review"];
const STEP_FIELDS: string[][] = [["groupId", "displayName", "backendId"], ["perUserAmount", "capAmount"], ["surfaces", "chargebackId", "priority", "families", "cacheReadPercent"], []];

interface DirectoryGroup { id: string; displayName: string; description: string | null; securityEnabled: boolean; memberCount?: number }

function GroupSearch({ form, set, errors, onMembers, chosenName, setChosenName }: { form: GroupForm; set: (p: Partial<GroupForm>) => void; errors: Record<string, string>; onMembers: (groupId: string, n: number | null) => void; chosenName: string; setChosenName: (name: string) => void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<DirectoryGroup[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const latest = useRef("");
  const search = async () => {
    setBusy(true); setError(null);
    try { setResults((await api<{ groups: DirectoryGroup[] }>(`/api/groups/directory?search=${encodeURIComponent(text.trim())}`)).data.groups); }
    catch (e) { setError(e); setResults(null); } finally { setBusy(false); }
  };
  const choose = async (g: DirectoryGroup) => {
    // The name follows the chosen group unless the admin typed their own.
    const keepName = form.displayName !== "" && form.displayName !== chosenName;
    set({ groupId: g.id, displayName: keepName ? form.displayName : g.displayName });
    setChosenName(g.displayName);
    latest.current = g.id;
    onMembers(g.id, null);
    let count: number | null = null;
    try { count = (await api<{ group: DirectoryGroup }>(`/api/groups/directory/${g.id}`)).data.group.memberCount ?? null; } catch { count = null; }
    if (latest.current === g.id) onMembers(g.id, count);
  };
  return (
    <div className="stack">
      <form className="row-fields" onSubmit={(e) => { e.preventDefault(); if (text.trim()) search(); }}>
        <Field label="Search Entra security groups" hint="Create the group in Microsoft Entra ID first. Search matches the start of words in the display name.">{(id, d) => (
          <input id={id} aria-describedby={d} className="input" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        )}</Field>
        <Button type="submit" icon="search" busy={busy} disabled={!text.trim()}>Search</Button>
      </form>
      {error ? <ErrorNote error={error} /> : null}
      {results && (results.length ? (
        <ul className="choice-list" aria-label="Matching groups">
          {results.map((g) => (
            <li key={g.id}>
              <button type="button" className={`choice${form.groupId === g.id ? " is-selected" : ""}`} aria-pressed={form.groupId === g.id} onClick={() => choose(g)}>
                <strong>{g.displayName}</strong> <span className="mono muted">{g.id}</span>{g.description ? <span className="muted"> · {g.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : <Empty title="No matching security groups">Check the spelling, or create the group in Microsoft Entra ID.</Empty>)}
      <Field label="Entra group Object ID" hint="Filled from the search, or paste it." error={errors.groupId}>{(id, d) => (
        <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.groupId)} className="input mono" value={form.groupId} onChange={(e) => set({ groupId: e.target.value.trim() })} autoComplete="off" spellCheck={false} />
      )}</Field>
    </div>
  );
}

export function GroupOnboard() {
  const session = useSession();
  const toast = useToast();
  const inventory = useQuery("/api/v2/inventory");
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<GroupForm>(emptyGroupForm);
  const [members, setMembers] = useState<{ groupId: string; count: number | null }>({ groupId: "", count: null });
  // Kept here, not in the search, so it survives leaving step 1 and coming back.
  const [chosenName, setChosenName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  if (!session.canWrite) return <div className="page"><PageHeader title="Onboard a group" /><Empty title="Read-only access">Onboarding groups needs the CCOF.Projects.Write role.</Empty></div>;
  const set = (patch: Partial<GroupForm>) => { setForm((f) => ({ ...f, ...patch })); setErrors((e) => clearErrors(e, patch)); };
  const backends: string[] = inventory.data?.data?.backends?.map((b: any) => b.backendId) ?? [];
  const next = () => {
    const all = formProblems(form);
    const here = Object.fromEntries(Object.entries(all).filter(([k]) => STEP_FIELDS[step].includes(k)));
    setErrors(here);
    if (!Object.keys(here).length) setStep(step + 1);
  };
  const body = formToBody(form);
  const create = async () => {
    const all = formProblems(form);
    if (Object.keys(all).length) { setErrors(all); return; }
    setBusy(true); setSaveError(null);
    try {
      await api("/api/groups", { method: "POST", body });
      toast(`Onboarded ${form.displayName}. Members get access after the next entitlement sync.`);
      navigate(`/groups/${body.groupId}`);
    } catch (e) { setSaveError(e); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <PageHeader title="Onboard a group" subtitle="Four steps. Nothing is saved until you onboard the group on the last step." />
      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "is-current" : i < step ? "is-done" : undefined} aria-current={i === step ? "step" : undefined}>
            <button type="button" disabled={i > step} onClick={() => setStep(i)}><span className="step-num" aria-hidden="true">{i + 1}</span>{s}</button>
          </li>
        ))}
      </ol>
      {step === 0 && (
        <Section title="Find the group">
          <GroupSearch form={form} set={set} errors={errors} onMembers={(groupId, count) => setMembers({ groupId, count })} chosenName={chosenName} setChosenName={setChosenName} />
          <div className="form-grid">
            <Field label="Display name" hint="Shown in the console and chargeback." error={errors.displayName}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.displayName)} className="input" value={form.displayName} maxLength={256} onChange={(e) => set({ displayName: e.target.value })} />}</Field>
            <Field label="Foundry backend" hint={backends.length ? "From the APIM inventory." : "Type the APIM backend ID."} error={errors.backendId}>{(id, d) => (
              <ChoiceInput id={id} describedBy={d} invalid={Boolean(errors.backendId)} value={form.backendId} options={backends} onChange={(backendId) => set({ backendId })} emptyLabel="Select a backend" />
            )}</Field>
          </div>
        </Section>
      )}
      {/* A member count only describes the group it was read for (a late reply or a pasted ID does not count). */}
      {step === 1 && <BudgetFields form={form} set={set} errors={errors} members={members.groupId === form.groupId.trim().toLowerCase() ? members.count : null} />}
      {step === 2 && (
        <div className="stack">
          <AccessFields form={form} set={set} errors={errors} />
          <ModelFields form={form} set={set} errors={errors} />
          <CacheFields form={form} set={set} errors={errors} autoApply />
          <AssistantFields form={form} set={set} />
        </div>
      )}
      {step === 3 && (
        <Section title="Review" description="This is the request that will be sent.">
          <dl className="facts facts-wide">
            <div><dt>Group</dt><dd><strong>{form.displayName}</strong> <span className="mono muted">{body.groupId as string}</span></dd></div>
            <div><dt>Budget</dt><dd>{form.perUserAmount} {form.currency} per user a month · {form.mode === "cap" ? `group cap ${form.capAmount} ${form.currency}` : "auto-scale"}</dd></div>
            <div><dt>Surfaces</dt><dd>{form.surfaces.join(", ")}</dd></div>
            <div><dt>Models</dt><dd>{Object.keys(form.policy.families).join(", ") || "none"}{form.restrictedFamiliesApproved ? " · restricted families approved" : ""}</dd></div>
            <div><dt>Chargeback ID</dt><dd>{form.chargebackId.trim() || "none"}</dd></div>
            <div><dt>Priority</dt><dd>{form.priority}</dd></div>
            <div><dt>Expected cache reads</dt><dd>{form.cacheReadPercent}% ({form.cacheBasis})</dd></div>
          </dl>
          <details className="data-table"><summary>Request (JSON)</summary><pre className="code-block">{JSON.stringify(body, null, 2)}</pre></details>
          {saveError ? <ErrorNote error={saveError} /> : null}
        </Section>
      )}
      <div className="form-actions stepper-actions">
        {step > 0 && <Button onClick={() => setStep(step - 1)} disabled={busy}>Back</Button>}
        {step < 3 && <Button variant="primary" onClick={next}>Continue</Button>}
        {step === 3 && <Button variant="primary" onClick={create} busy={busy}>Onboard group</Button>}
        <a className="btn btn-quiet" href={href("/groups")}>Cancel</a>
        {Object.keys(errors).length > 0 && <span className="field-error" role="alert">{Object.keys(errors).length} field{Object.keys(errors).length === 1 ? " needs" : "s need"} attention</span>}
      </div>
      {saveError && (saveError as any).problems?.length ? <p className="hint">{errorMessage(saveError)}</p> : null}
    </div>
  );
}
