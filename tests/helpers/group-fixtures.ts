// Test fixtures for onboarded group documents (ADR-0034).

import { GROUP_STD, familyPolicy } from "./sync-fakes.ts";

export const GROUP_A = GROUP_STD;
export const GROUP_B = "55555555-5555-4555-8555-555555555555";

export function groupDoc(groupId = GROUP_A, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: groupId,
    kind: "group",
    groupId,
    projectId: groupId,
    displayName: "Payments engineering",
    status: "active",
    backendId: "foundry-sample-hub",
    priority: 100,
    chargebackId: "WBS-1234.01",
    budget: {
      mode: "autoScale",
      perUser: { amount: 50, currency: "USD", period: "monthly" },
      groupCap: null,
    },
    restrictedFamiliesApproved: false,
    familyPolicy: familyPolicy(["claude-haiku-4-5", "claude-sonnet-5"]),
    surfaces: ["code", "chat"],
    cacheProfile: { expectedCacheReadPercent: 80, basis: "suggested" },
    ...overrides,
  };
}

export function restrictedPolicy() {
  const policy = familyPolicy(["claude-haiku-4-5"]);
  const unlimited = { tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null };
  return { ...policy, families: { ...policy.families, mythos: { models: ["claude-mythos-1"], person: unlimited, group: unlimited } } };
}
