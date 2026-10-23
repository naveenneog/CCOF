// Which of the person's memberships a request is for. Two paths:
// - the key path (ADR-0002): subscriptionIndex names the project and the
//   person's own entitlement record must confirm it;
// - the selector path (docs/PILOT.md C-1, ADR-0006's rule): no key; an
//   optional projectId selector chooses among the person's active memberships,
//   and with no selector the single active project is used, or, when every
//   active membership is an onboarded group, the one with the higher per-user
//   budget, then the lower priority (ADR-0034 decision 5).
// Either way the selector only chooses; authorization comes from the record.

import type { EntitlementRecord, ProjectMembership, ResolveDependencies, ResolveInput } from "./decide.ts";
import { checkEntitlementRecord } from "./freshness.ts";
import type { ResolveRefusal } from "./refusals.ts";
import { refuse, settledValue } from "./refusals.ts";
import { GROUP_SCOPE_CODE } from "../contracts/model-families.ts";
import { budgetInBothUnits, parseBudget } from "../cost/budget-units.ts";
import { MAX_PRIORITY } from "../contracts/group-registration.ts";
import type { Decimal } from "decimal.js";

export type Selection = { membership: ProjectMembership } | ResolveRefusal;

type Usable = { record: EntitlementRecord } | { refusal: ResolveRefusal };

// A missing document and an empty membership list are the same refusal (C-4);
// a malformed record is a per-record 503 (ADR-0008).
function usableEntitlement(entitlement: EntitlementRecord | null, nowMs: number, projectId?: string): Usable {
  if (!entitlement) return { refusal: refuse("no_entitlement", projectId) };
  const verdict = checkEntitlementRecord(entitlement, nowMs);
  if (!verdict.usable) {
    const detail = verdict.reason === "entitlement_record_invalid" ? verdict.detail : undefined;
    return { refusal: refuse(verdict.reason, projectId, detail) };
  }
  if (entitlement.projectMemberships.length === 0) return { refusal: refuse("no_entitlement", projectId) };
  return { record: entitlement };
}

const isActive = (membership: ProjectMembership | null | undefined): membership is ProjectMembership =>
  membership?.status === "active";

// One active membership per project is the rule (docs/LLD.md §4). Two leave the
// classification ambiguous, and picking one could pick the more privileged one,
// so the record is malformed for that project on every path.
function pickInProject(active: ProjectMembership[], projectId: string, logProjectId: boolean): Selection {
  const inProject = active.filter((m) => m.projectId === projectId);
  if (inProject.length === 0) return refuse("project_mismatch", logProjectId ? projectId : undefined);
  if (inProject.length > 1) return refuse("entitlement_record_invalid", projectId, "duplicate_active_membership");
  return { membership: inProject[0] };
}

export async function selectByKey(
  input: ResolveInput & { subscriptionId: string },
  deps: ResolveDependencies,
  nowMs: number,
  signal?: AbortSignal,
): Promise<Selection> {
  // Both keys come from the request, so both reads start together.
  const [subIndexRead, entitlementRead] = await Promise.allSettled([
    deps.readSubscriptionIndex(input.subscriptionId, signal),
    deps.readEntitlement(input.personId, signal),
  ]);

  const subIndex = settledValue(subIndexRead);
  if (!subIndex || subIndex.status !== "active") return refuse("unknown_subscription");
  const keyProjectId = subIndex.projectId;
  if (subIndex.personId !== input.personId) return refuse("subscription_person_mismatch", keyProjectId);
  // A selector sent with a key must name the key's own project.
  if (input.projectId !== undefined && input.projectId !== keyProjectId) return refuse("project_mismatch", keyProjectId);

  const usable = usableEntitlement(settledValue(entitlementRead), nowMs, keyProjectId);
  if ("refusal" in usable) return usable.refusal;
  const selection = pickInProject(usable.record.projectMemberships.filter(isActive), keyProjectId, true);
  if ("refused" in selection) return selection;
  if (selection.membership.classification !== subIndex.classification) {
    return refuse("classification_mismatch", keyProjectId);
  }
  return selection;
}

// Without a selector, among memberships that are all onboarded groups, the group with the higher
// per-user monthly budget applies, compared in CCU; equal budgets fall back to the lower priority
// (ADR-0034 decision 5, owner decision 2026-10-23). Anything still tied, a missing or malformed
// budget or priority, or any baseline membership leaves the choice to the caller.
function preferredGroup(active: ProjectMembership[]): string | null {
  const ranked: { projectId: string; ccu: Decimal; priority: number }[] = [];
  for (const m of active) {
    const raw = m as unknown as Record<string, unknown>;
    const priority = raw.priority;
    if (m.classification !== GROUP_SCOPE_CODE || !Number.isSafeInteger(priority) || (priority as number) < 1 || (priority as number) > MAX_PRIORITY) return null;
    let ccu: Decimal;
    try { ccu = budgetInBothUnits(parseBudget(raw.perUserBudget, "perUserBudget")).ccu; } catch { return null; }
    ranked.push({ projectId: m.projectId, ccu, priority: priority as number });
  }
  ranked.sort((a, b) => b.ccu.comparedTo(a.ccu) || a.priority - b.priority);
  const best = ranked[0];
  const winners = new Set(ranked.filter((r) => r.ccu.equals(best.ccu) && r.priority === best.priority).map((r) => r.projectId));
  return winners.size === 1 ? best.projectId : null;
}

export async function selectBySelector(
  input: ResolveInput,
  deps: ResolveDependencies,
  nowMs: number,
  signal?: AbortSignal,
): Promise<Selection> {
  const usable = usableEntitlement(await deps.readEntitlement(input.personId, signal), nowMs);
  if ("refusal" in usable) return usable.refusal;
  const active = usable.record.projectMemberships.filter(isActive);

  // A selector that is not one of the person's projects gets the same collapsed
  // 403 as any other refusal and is not echoed (ADR-0006 decisions 3 and 4).
  if (input.projectId !== undefined) return pickInProject(active, input.projectId, false);

  const projects = new Set(active.map((m) => m.projectId));
  if (projects.size === 0) return refuse("no_entitlement");
  if (projects.size > 1) {
    const chosen = preferredGroup(active);
    return chosen === null ? refuse("project_selection_required") : pickInProject(active, chosen, true);
  }
  return pickInProject(active, active[0].projectId, true);
}
