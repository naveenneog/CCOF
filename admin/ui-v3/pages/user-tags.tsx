import { useEffect, useState } from "react";
import { api, qs, useQuery } from "../lib/api.ts";
import { when } from "../lib/format.ts";
import { href } from "../lib/router.ts";
import { loadedTagFor, personProblem, tagProblem, tagWrite } from "../lib/user-tags.ts";
import { Button, CapabilityNotice, DataTable, Empty, ErrorNote, Field, Loading, PageHeader, Section, useToast } from "../components/ui.tsx";
import { useSession } from "../components/shell.tsx";
import { UserIdentity } from "../components/user-identity.tsx";
import { TagInput } from "../components/tag-input.tsx";

// Individual user tags (owner decision 2026-10-23): the chargeback ID (for example a WBS element) each
// person's usage carries. Set when a person is onboarded; the next entitlement sync applies it.
export function UserTags({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState(query.get("tag") ?? "");
  const listed = useQuery(`/api/user-tags/people${qs({ tag: filter && !tagProblem(filter) ? filter : null, limit: 500 })}`);
  const [person, setPerson] = useState(query.get("person") ?? "");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const personError = person ? personProblem(person) : null;
  const tagError = tagProblem(tag);
  // The person's current tag and its version, loaded when the person is chosen; Save sends that version,
  // so a change someone else made in between is refused (412) instead of overwritten.
  const current = useQuery(person && !personError ? `/api/user-tags/people/${encodeURIComponent(person.toLowerCase())}` : null);
  const loaded = loadedTagFor(person, current.data, current.loading, current.etag);
  useEffect(() => { if (loaded.ready) setTag(loaded.tag); }, [loaded.ready, loaded.tag, person]);

  const save = async () => {
    if (!loaded.ready) return;
    setBusy(true); setError(null);
    try {
      const w = tagWrite(person, tag, loaded.exists ? { etag: loaded.etag } : null);
      const r = await api(w.path, { method: "PUT", body: w.body, ...(w.ifMatch ? { ifMatch: w.ifMatch } : { ifNoneMatch: w.ifNoneMatch }) });
      toast(!tag ? "Tag cleared. The group's default chargeback ID applies after the next sync."
        : r.data?.suggestionSaved === false ? `Tagged ${tag}, but it could not be added to the saved suggestions (the list is full or busy). Usage carries it after the next sync.`
        : `Tagged ${tag}. Usage carries it after the next entitlement sync.`);
      setPerson(""); setTag("");
      listed.reload();
    } catch (e) { setError(e); current.reload(); } finally { setBusy(false); }
  };

  const rows = (listed.data?.people ?? []) as any[];
  const unchanged = loaded.ready && tag === loaded.tag;
  return (
    <div className="page">
      <PageHeader title="User tags" subtitle="The chargeback ID (for example a WBS element) each person's usage is charged to. Saved tags are suggested while you type."
        observedAt={listed.observedAt} onRefresh={listed.reload} busy={listed.loading} />
      {session.canWrite && (
        <Section title="Tag a person" description="Pick a member of an onboarded group, or enter the person's Entra object ID. A new tag is saved and suggested next time. Leave the tag empty to clear it; the group's own chargeback ID then applies.">
          <MemberPicker onPick={(id) => { setPerson(id); setError(null); }} />
          <div className="form-grid">
            <Field label="Person (Entra object ID)" error={personError}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(personError) || undefined} className="input mono"
              value={person} onChange={(e) => { setPerson(e.target.value.trim()); setError(null); }} autoComplete="off" spellCheck={false} />}</Field>
            <Field label="User tag" hint="For example WBS-1234.01" error={tagError}>{(id, d) => <TagInput id={id} describedBy={d} value={tag} onChange={setTag} invalid={Boolean(tagError)} />}</Field>
          </div>
          {person && !personError && (
            <div className="person-status" role="status" aria-live="polite">
              {!loaded.ready && !current.error ? <span className="muted">Loading this person's tag…</span>
                : current.error ? <ErrorNote error={current.error} retry={current.reload} />
                : <dl className="facts"><div><dt>Person</dt><dd><UserIdentity objectId={person.toLowerCase()} /></dd></div>
                    <div><dt>Current tag</dt><dd>{loaded.tag ? <code>{loaded.tag}</code> : <span className="muted">none (the group's chargeback ID applies)</span>}</dd></div></dl>}
            </div>
          )}
          {error ? <ErrorNote error={error} /> : null}
          <div className="form-actions"><Button variant="primary" busy={busy} disabled={!person || Boolean(personError) || Boolean(tagError) || busy || !loaded.ready || unchanged} onClick={save}>Save tag</Button></div>
        </Section>
      )}
      <Section title="Tagged people" description={<>Filter by a tag. Chargeback filters by the same tag: <a href={href(`/chargeback${qs({ chargeback: filter && !tagProblem(filter) ? filter : null })}`)}>open chargeback</a>.</>}>
        <div className="filter-bar">
          <Field label="Tag" error={tagProblem(filter)}>{(id, d) => <TagInput id={id} describedBy={d} value={filter} onChange={setFilter} invalid={Boolean(tagProblem(filter))} placeholder="All tags" />}</Field>
        </div>
        {listed.error ? <ErrorNote error={listed.error} retry={listed.reload} /> : listed.loading && !listed.data ? <Loading rows={4} /> : (
          <DataTable caption="Tagged people" rows={rows} rowKey={(r) => r.personId}
            empty={<Empty title={filter ? "No one has this tag" : "No one is tagged yet"}>{session.canWrite ? "Tag a person above." : "An editor can tag people."}</Empty>}
            onRowClick={session.canWrite ? (r) => { setPerson(r.personId); setError(null); document.getElementById("page-title")?.scrollIntoView(); } : undefined}
            columns={[
              { key: "personId", label: "User / object ID", render: (r) => <UserIdentity objectId={r.personId} /> },
              { key: "tag", label: "User tag", render: (r) => r.tag ? <code>{r.tag}</code> : <span className="muted">cleared</span> },
              { key: "updatedAt", label: "Changed", render: (r) => r.updatedAt ? when(r.updatedAt) : "—" },
              { key: "updatedBy", label: "Changed by", render: (r) => <UserIdentity objectId={r.updatedBy} /> },
            ]} />
        )}
        {listed.data?.truncated ? <p className="muted">Showing the first 500. Filter by a tag to narrow the list.</p> : null}
      </Section>
    </div>
  );
}

// Members of an onboarded group, read from Microsoft Graph (needs ADMIN_GROUP_SEARCH_ENABLED and
// GroupMember.ReadBasic.All), so the admin picks a person instead of copying an object ID.
function MemberPicker({ onPick }: { onPick: (personId: string) => void }) {
  const groups = useQuery("/api/groups");
  const [groupId, setGroupId] = useState("");
  const members = useQuery(groupId ? `/api/groups/directory/${encodeURIComponent(groupId)}/members` : null);
  const active = ((groups.data?.groups ?? []) as any[]).filter((g) => g.status === "active");
  if (groups.error) return <ErrorNote error={groups.error} retry={groups.reload} />;
  if (!active.length) return groups.loading ? <Loading rows={1} /> : null;
  const directoryOff = members.error && /group_directory_(disabled|not_configured|permission_required)/.test(String((members.error as any).code));
  return (
    <div className="form-grid">
      <Field label="Onboarded group" hint="Lists its direct members">{(id, d) => (
        <select id={id} aria-describedby={d} className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Choose a group…</option>
          {active.map((g) => <option key={g.groupId} value={g.groupId}>{g.displayName}</option>)}
        </select>)}</Field>
      <div>
        {!groupId ? null : members.loading && !members.data ? <Loading rows={2} />
          : directoryOff ? <CapabilityNotice cap={{ state: "disabled", permission: "Group member listing needs ADMIN_GROUP_SEARCH_ENABLED=true and Microsoft Graph GroupMember.ReadBasic.All on the admin app. Enter the object ID instead." }} what="Member list" />
          : members.error ? <ErrorNote error={members.error} retry={members.reload} />
          : (members.data?.members ?? []).length === 0 ? <Empty title="No user members">This group has no direct user members.</Empty>
          : (
            <ul className="pick-list" aria-label="Group members">
              {(members.data.members as any[]).map((m) => (
                <li key={m.id}><Button onClick={() => onPick(m.id)}>{m.displayName ?? "(no name)"}</Button> <code className="muted">{m.id}</code></li>
              ))}
              {members.data.truncated ? <li className="muted">More members exist; enter the object ID for anyone not listed.</li> : null}
            </ul>
          )}
      </div>
    </div>
  );
}
