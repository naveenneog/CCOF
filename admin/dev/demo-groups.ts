import type { Doc } from "../src/validation.ts";

const limit = (tpm: number | null, quota: number | null) =>
  ({ tokensPerMinute: tpm, tokenQuota: quota, tokenQuotaPeriod: quota === null ? null : "Monthly" });
const names = ["Payments engineering", "Payments data science", "Claims automation", "Developer portal",
  "Fraud analytics", "HR assistant", "Legal review", "Marketing studio", "Network ops", "Procurement",
  "Quality engineering", "Risk models", "Sales enablement", "Security research", "Supply chain", "Tax engine",
  "Treasury", "Underwriting", "Vendor onboarding", "Warehouse robotics", "Data platform", "Mobile banking",
  "Observability", "Pricing service", "Search relevance", "Voice bots"];
const ids = ["7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "8b2d3c4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"];

export function createDemoGroups(): Doc[] {
  return names.map((displayName, i) => {
    const groupId = ids[i] ?? `${(0x1a2b0000 + i).toString(16)}-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
    return {
      id: groupId, projectId: groupId, kind: "group", groupId, displayName, status: "active", retiredAt: null,
      backendId: i === names.length - 1 ? "foundry-wus3" : i % 4 === 0 ? "foundry-swc" : "foundry-eus2",
      priority: i + 1, chargebackId: `DEMO-${i + 1}`, restrictedFamiliesApproved: false,
      budget: { mode: "cap", perUser: { amount: 25, currency: "USD", period: "monthly" },
        groupCap: { amount: i === 1 ? 40 : 80 + (i % 5) * 40, currency: "USD", period: "monthly" } },
      familyPolicy: {
        aggregateLimits: { person: limit(20000, 2000000), group: limit(150000, 40000000) },
        families: {
          sonnet: { models: ["claude-sonnet-5"], person: limit(20000, 2000000), group: limit(120000, null) },
          haiku: { models: ["claude-haiku-4-5"], person: limit(20000, 2000000), group: limit(120000, null) },
        },
      },
      surfaces: ["code"], cacheProfile: { expectedCacheReadPercent: 60, basis: "custom" },
    };
  });
}
