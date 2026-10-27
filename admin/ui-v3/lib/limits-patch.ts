import type { FamilyPolicy } from "../components/limits.tsx";
import type { LimitsPatch } from "../components/budget-assistant.tsx";

export function applyPatch(policy: FamilyPolicy, patch: LimitsPatch): FamilyPolicy {
  const next = structuredClone(policy);
  next.aggregateLimits = { ...next.aggregateLimits, ...patch.aggregateLimits };
  for (const [f, v] of Object.entries(patch.families)) if (next.families[f]) next.families[f] = { ...next.families[f], ...v };
  return next;
}
