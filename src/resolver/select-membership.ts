// Which of the person's memberships a request is for. Two paths:
// - the key path (ADR-0002): subscriptionIndex names the project and the
//   person's own entitlement record must confirm it;
// - the selector path (docs/PILOT.md C-1, ADR-0006's rule): no key; an
//   optional projectId selector chooses among the person's active memberships,
//   and with no selector the single active project is used, or, when every
//   active membership is an onboarded group, the one where the person has the
//   higher month-to-date spend, then the lower priority (ADR-0034 decision 5).
// Either way the selector only chooses; authorization comes from the record.

import type { BudgetStateRecord, EntitlementRecord, ProjectMembership, ResolveDependencies, ResolveInput } from "./decide.ts";
import { checkEntitlementRecord } from "./freshness.ts";
import type { ResolveRefusal } from "./refusals.ts";
import { refuse, settledValue } from "./refusals.ts";
import { GROUP_SCOPE_CODE } from "../contracts/model-families.ts";
import { Money } from "../cost/money.ts";
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

// Without a selector, among memberships that are all onboarded groups, the group where the person has
// spent the most this UTC month applies (ADR-0034 decision 5; owner decision 2026-10-23, "higher usage
// spend"). Spend is the reconciler's exact decimal spentCcu in the person's budgetState for that group
// (src/reconciler/reconcile-person.ts); no state, or a state for an earlier month, is no spend this month.
// Equal spend falls back to the lower priority. Anything still tied, a malformed priority or any baseline
// membership leaves the choice to the caller; a malformed spend is budget_state_invalid. A failed read
// fails the request, as every other registry read does.
// A non-negative plain decimal as Decimal.toFixed() writes it (no exponent, no sign, no length cap: the writer
// has none either). Construction and comparedTo are exact at any length; precision applies only to arithmetic.
const SPENT_CCU = /^\d+(\.\d+)?$/;

async function preferredGroup(
  active: ProjectMembership[], personId: string, deps: ResolveDependencies, nowMs: number, signal?: AbortSignal,
): Promise<{ projectId: string | null } | ResolveRefusal> {
  const candidates: { projectId: string; priority: number }[] = [];
  for (const m of active) {
    const priority = (m as unknown as Record<string, unknown>).priority;
    if (m.classification !== GROUP_SCOPE_CODE || !Number.isSafeInteger(priority) || (priority as number) < 1 || (priority as number) > MAX_PRIORITY) {
      return { projectId: null };
    }
    candidates.push({ projectId: m.projectId, priority: priority as number });
  }
  // The budget period label, "YYYY-MM" in UTC, as the reconciler writes it (src/reconciler/period.ts).
  const period = new Date(nowMs).toISOString().slice(0, 7);
  const states = await Promise.all(candidates.map((c) => deps.readBudgetState(personId, c.projectId, signal)));
  const ranked: { projectId: string; priority: number; spent: Decimal }[] = [];
  for (const [i, c] of candidates.entries()) {
    const s = states[i] as (BudgetStateRecord & { spentCcu?: unknown; period?: unknown }) | null;
    let spent = new Money(0);
    if (s && s.period === period) {
      if (typeof s.spentCcu !== "string" || !SPENT_CCU.test(s.spentCcu)) return refuse("budget_state_invalid", c.projectId);
      spent = new Money(s.spentCcu);
    }
    ranked.push({ ...c, spent });
  }
  ranked.sort((a, b) => b.spent.comparedTo(a.spent) || a.priority - b.priority);
  const best = ranked[0];
  const winners = new Set(ranked.filter((r) => r.spent.equals(best.spent) && r.priority === best.priority).map((r) => r.projectId));
  return { projectId: winners.size === 1 ? best.projectId : null };
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
    const chosen = await preferredGroup(active, input.personId, deps, nowMs, signal);
    if ("refused" in chosen) return chosen;
    return chosen.projectId === null ? refuse("project_selection_required") : pickInProject(active, chosen.projectId, true);
  }
  return pickInProject(active, active[0].projectId, true);
}
