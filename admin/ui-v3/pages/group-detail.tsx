import { useEffect, useState } from "react";
import { api, errorMessage, useQuery } from "../lib/api.ts";
import { href, navigate } from "../lib/router.ts";
import { clearErrors, formFromDoc, formProblems, formToBody } from "../lib/groups.ts";
import type { GroupForm } from "../lib/groups.ts";
import { Button, Empty, ErrorNote, Field, Loading, PageHeader, Section, StatePill, useToast } from "../components/ui.tsx";
import { AccessFields, AssistantFields, BudgetFields, CacheFields, ModelFields } from "../components/group-fields.tsx";
import { useSession } from "../components/shell.tsx";

export function GroupDetail({ id }: { id: string }) {
  const session = useSession();
  const toast = useToast();
  const doc = useQuery<Record<string, unknown>>(`/api/groups/${encodeURIComponent(id)}`);
  const directory = useQuery<{ group: { memberCount?: number } }>(`/api/groups/directory/${encodeURIComponent(id)}`);
  const [form, setForm] = useState<GroupForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState("");
  useEffect(() => { if (doc.data) setForm(formFromDoc(doc.data)); }, [doc.data]);
  if (doc.loading && !doc.data) return <div className="page"><PageHeader title="Group" /><Loading label="Loading the group" /></div>;
  if (doc.error) return <div className="page"><PageHeader title="Group" /><ErrorNote error={doc.error} retry={doc.reload} /></div>;
  if (!doc.data || !form) return null;
  const retired = doc.data.status === "retired";
  const readOnly = retired || !session.canWrite;
  const set = (patch: Partial<GroupForm>) => { setForm((f) => (f ? { ...f, ...patch } : f)); setErrors((e) => clearErrors(e, patch)); };
  const members = directory.data?.group?.memberCount ?? null;
  const save = async () => {
    const problems = formProblems(form);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    const { groupId: _id, ...changes } = formToBody(form);
    setBusy(true); setSaveError(null);
    try {
      await api(`/api/groups/${encodeURIComponent(id)}`, { method: "PUT", body: changes, ifMatch: doc.etag });
      toast("Saved. Members' entitlements update at the next sync.");
      doc.reload();
    } catch (e) { setSaveError(e); } finally { setBusy(false); }
  };
  const retire = async () => {
    setBusy(true); setSaveError(null);
    try {
      await api(`/api/groups/${encodeURIComponent(id)}/retire`, { method: "POST", body: { confirmGroupId: id }, ifMatch: doc.etag });
      toast("Retired. The next sync removes every member's access.");
      navigate("/groups");
    } catch (e) { setSaveError(e); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <PageHeader title={String(doc.data.displayName)} subtitle={<span className="mono">{id}</span>}
        actions={<StatePill state={retired ? "disabled" : "available"} label={String(doc.data.status)} />} />
      {retired && <p className="notice" role="status">This group was retired on {String(doc.data.retiredAt)}. It is read-only.</p>}
      <fieldset className="fieldset-plain" disabled={readOnly}>
        <div className="stack">
          <BudgetFields form={form} set={set} errors={errors} members={members} />
          <AccessFields form={form} set={set} errors={errors} />
          <ModelFields form={form} set={set} errors={errors} />
          <CacheFields form={form} set={set} errors={errors} readOnly={readOnly} />
          {!readOnly && <AssistantFields form={form} set={set} />}
        </div>
      </fieldset>
      {saveError ? <ErrorNote error={saveError} /> : null}
      {saveError && (saveError as any).problems?.length ? <p className="hint">{errorMessage(saveError)}</p> : null}
      {!readOnly && (
        <>
          <div className="form-actions">
            <Button variant="primary" onClick={save} busy={busy}>Save changes</Button>
            <a className="btn btn-quiet" href={href("/groups")}>Back to groups</a>
            {Object.keys(errors).length > 0 && <span className="field-error" role="alert">{Object.keys(errors).length} field{Object.keys(errors).length === 1 ? " needs" : "s need"} attention</span>}
          </div>
          <Section title="Retire this group" description="One way. The next entitlement sync removes access for every member; the Entra group itself is not changed.">
            <Field label="Type the group's Object ID to confirm">{(fid) => <input id={fid} className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} autoComplete="off" spellCheck={false} />}</Field>
            <Button variant="danger" onClick={retire} busy={busy} disabled={confirm.toLowerCase() !== id.toLowerCase()}>Retire group</Button>
          </Section>
        </>
      )}
      {!session.canWrite && !retired && <Empty title="Read-only access">Changing groups needs the CCOF.Projects.Write role.</Empty>}
    </div>
  );
}
