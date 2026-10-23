import { useState } from "react";
import { useQuery } from "../lib/api.ts";
import { href } from "../lib/router.ts";
import { Button, DataTable, Empty, ErrorNote, Loading, PageHeader, Section, StatePill, useToast } from "../components/ui.tsx";
import { downloadExport } from "../components/group-fields.tsx";
import { useSession } from "../components/shell.tsx";

interface GroupSummary { groupId: string; displayName: string; status: string; priority: number; chargebackId: string | null; budgetMode: string | null; surfaces: string[]; backendId: string }

const SURFACE_LABEL: Record<string, string> = { code: "Code", chat: "Chat", m365: "M365", cowork: "Cowork", design: "Design" };

export function Groups() {
  const session = useSession();
  const toast = useToast();
  const list = useQuery<{ groups: GroupSummary[] }>("/api/groups");
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (kind: "groups" | "usage") => {
    setBusy(kind);
    try {
      await downloadExport(`/api/v3/export/${kind}?format=csv${kind === "usage" ? "&period=month" : ""}`, `ccof-${kind}.csv`);
      toast(kind === "usage" ? "Downloaded this month's usage by chargeback ID, group and person." : "Downloaded the group configuration.");
    } catch (e) { toast(e instanceof Error ? e.message : "The export failed."); } finally { setBusy(null); }
  };
  const groups = list.data?.groups ?? [];
  return (
    <div className="page">
      <PageHeader title="Groups" subtitle="Entra groups onboarded to Claude. Each group has its own budget, models, surfaces and chargeback ID."
        observedAt={list.observedAt} onRefresh={list.reload} busy={list.loading}
        actions={<>
          <Button icon="download" onClick={() => download("usage")} busy={busy === "usage"}>Usage CSV (this month)</Button>
          <Button icon="download" onClick={() => download("groups")} busy={busy === "groups"}>Groups CSV</Button>
          {session.canWrite && <a className="btn btn-primary" href={href("/groups/new")}>Onboard a group</a>}
        </>} />
      <Section title="Onboarded groups">
        {list.loading && !list.data ? <Loading label="Loading groups" /> : list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !groups.length ? (
          <Empty title="No groups onboarded yet" action={session.canWrite ? <a className="btn btn-primary" href={href("/groups/new")}>Onboard a group</a> : undefined}>
            Create a security group in Microsoft Entra ID first, then find it here and set its budget.
          </Empty>
        ) : (
          <DataTable<GroupSummary> caption="Onboarded groups" rows={groups} rowKey={(g) => g.groupId}
            onRowClick={(g) => { location.hash = `/groups/${g.groupId}`; }}
            columns={[
              { key: "displayName", label: "Group", render: (g) => <a href={href(`/groups/${g.groupId}`)}>{g.displayName}</a> },
              { key: "status", label: "Status", render: (g) => <StatePill state={g.status === "active" ? "available" : "disabled"} label={g.status} /> },
              { key: "chargebackId", label: "Chargeback ID", render: (g) => g.chargebackId ? <code>{g.chargebackId}</code> : <span className="muted">none</span> },
              { key: "budgetMode", label: "Budget", render: (g) => g.budgetMode === "cap" ? "Capped" : "Auto-scale" },
              { key: "surfaces", label: "Surfaces", render: (g) => (g.surfaces ?? []).map((s) => SURFACE_LABEL[s] ?? s).join(", ") },
              { key: "priority", label: "Priority", align: "end" },
            ]} />
        )}
      </Section>
    </div>
  );
}
