// Group onboarding form logic (ADR-0034, ROADMAP G8). Pure, so it is unit-tested in Node. The server
// validates every request with src/contracts/group-registration.ts; these checks only explain problems
// before sending. Patterns mirror that contract.

export type Surface = "chat" | "code" | "cowork" | "design" | "m365";
export const SURFACE_OPTIONS: { value: Surface; label: string; note?: string }[] = [
  { value: "code", label: "Claude Code" },
  { value: "chat", label: "Chat" },
  { value: "m365", label: "Microsoft 365 (Claude Office add-ins)" },
  { value: "cowork", label: "Cowork", note: "Runs on Anthropic's servers; not routed through this gateway." },
  { value: "design", label: "Design", note: "Placeholder: no Foundry path yet." },
];

interface Limit { tokensPerMinute: number | null; tokenQuota: number | null; tokenQuotaPeriod: string | null }
export interface PolicyLike { aggregateLimits: { person: Limit; group: Limit }; families: Record<string, { models: string[]; person: Limit; group: Limit }> }

export interface GroupForm {
  groupId: string;
  displayName: string;
  backendId: string;
  priority: string;
  chargebackId: string;
  perUserAmount: string;
  currency: "USD" | "CCU";
  mode: "autoScale" | "cap";
  capAmount: string;
  surfaces: Surface[];
  restrictedFamiliesApproved: boolean;
  policy: PolicyLike;
  cacheReadPercent: string;
  cacheBasis: "suggested" | "custom";
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const CHARGEBACK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const emptyLimit = (): Limit => ({ tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null });

export function emptyGroupForm(): GroupForm {
  return {
    groupId: "", displayName: "", backendId: "", priority: "100", chargebackId: "", perUserAmount: "50", currency: "USD",
    mode: "autoScale", capAmount: "", surfaces: ["code"], restrictedFamiliesApproved: false,
    policy: { aggregateLimits: { person: emptyLimit(), group: emptyLimit() }, families: {} },
    cacheReadPercent: "85", cacheBasis: "suggested",
  };
}

const num = (text: string) => (text.trim() === "" ? NaN : Number(text));
const money = (amount: number, currency: string) => ({ amount, currency, period: "monthly" });

export function formToBody(form: GroupForm): Record<string, unknown> {
  const chargeback = form.chargebackId.trim();
  return {
    groupId: form.groupId.trim().toLowerCase(),
    displayName: form.displayName.trim(),
    backendId: form.backendId.trim(),
    priority: num(form.priority),
    chargebackId: chargeback === "" ? null : chargeback,
    budget: {
      mode: form.mode,
      perUser: money(num(form.perUserAmount), form.currency),
      groupCap: form.mode === "cap" ? money(num(form.capAmount), form.currency) : null,
    },
    restrictedFamiliesApproved: form.restrictedFamiliesApproved,
    familyPolicy: form.policy,
    surfaces: [...form.surfaces],
    cacheProfile: { expectedCacheReadPercent: num(form.cacheReadPercent), basis: form.cacheBasis },
  };
}

export function formProblems(form: GroupForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!GUID.test(form.groupId.trim())) p.groupId = "Choose an Entra group from the search, or paste its Object ID.";
  if (!form.displayName.trim() || form.displayName.trim().length > 256) p.displayName = "A name of 1 to 256 characters.";
  if (!ID.test(form.backendId.trim())) p.backendId = "The APIM backend ID the group routes to.";
  const priority = num(form.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 10000) p.priority = "A whole number from 1 to 10,000; between groups where a person has equal spend this month, the lower number wins.";
  const chargeback = form.chargebackId.trim();
  if (chargeback !== "" && !CHARGEBACK_ID.test(chargeback)) p.chargebackId = "Letters, digits and . _ / - only, starting with a letter or digit; up to 64.";
  const perUser = num(form.perUserAmount);
  if (!Number.isFinite(perUser) || perUser <= 0) p.perUserAmount = "A monthly amount above zero.";
  if (form.mode === "cap") {
    const cap = num(form.capAmount);
    if (!Number.isFinite(cap) || cap <= 0 || (Number.isFinite(perUser) && cap < perUser)) p.capAmount = "A monthly group cap of at least the per-user budget.";
  }
  if (form.surfaces.length === 0) p.surfaces = "Allow at least one surface.";
  if (Object.keys(form.policy.families).length === 0) p.families = "Admit at least one model family.";
  const cache = num(form.cacheReadPercent);
  if (!Number.isFinite(cache) || cache < 0 || cache > 100) p.cacheReadPercent = "A percentage from 0 to 100.";
  return p;
}

// What the budget means for the group's current direct members: auto-scale grows with the group;
// a cap is the most the group can spend however many members it has.
export function groupEstimate(form: GroupForm, members: number | null) {
  const perUser = num(form.perUserAmount);
  if (members === null || !Number.isFinite(perUser)) return null;
  const uncapped = perUser * members;
  const cap = num(form.capAmount);
  const capBinds = form.mode === "cap" && Number.isFinite(cap) && cap < uncapped;
  return { perUser, members, uncapped, ceiling: form.mode === "cap" && Number.isFinite(cap) ? Math.min(cap, uncapped) : uncapped, currency: form.currency, capBinds };
}

// Editing a field clears that field's error; the next Continue or Save checks everything again.
const ERROR_KEYS: Partial<Record<keyof GroupForm, string[]>> = { policy: ["families"], mode: ["capAmount"], currency: ["perUserAmount", "capAmount"] };
export function clearErrors(errors: Record<string, string>, patch: Partial<GroupForm>): Record<string, string> {
  const cleared = new Set(Object.keys(patch).flatMap((k) => ERROR_KEYS[k as keyof GroupForm] ?? [k]));
  return Object.fromEntries(Object.entries(errors).filter(([k]) => !cleared.has(k)));
}

export function formFromDoc(doc: Record<string, unknown>): GroupForm {
  const budget = (doc.budget ?? {}) as { mode?: string; perUser?: { amount?: number; currency?: string }; groupCap?: { amount?: number } | null };
  const cache = (doc.cacheProfile ?? {}) as { expectedCacheReadPercent?: number; basis?: string };
  return {
    groupId: String(doc.groupId ?? ""), displayName: String(doc.displayName ?? ""), backendId: String(doc.backendId ?? ""),
    priority: String(doc.priority ?? ""), chargebackId: typeof doc.chargebackId === "string" ? doc.chargebackId : "",
    perUserAmount: String(budget.perUser?.amount ?? ""), currency: budget.perUser?.currency === "CCU" ? "CCU" : "USD",
    mode: budget.mode === "cap" ? "cap" : "autoScale", capAmount: budget.groupCap ? String(budget.groupCap.amount ?? "") : "",
    surfaces: Array.isArray(doc.surfaces) ? (doc.surfaces as Surface[]) : [],
    restrictedFamiliesApproved: doc.restrictedFamiliesApproved === true,
    policy: (doc.familyPolicy ?? emptyGroupForm().policy) as PolicyLike,
    cacheReadPercent: String(cache.expectedCacheReadPercent ?? ""), cacheBasis: cache.basis === "custom" ? "custom" : "suggested",
  };
}
