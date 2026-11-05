import { fakeReads, activeMembership, entitlementWithMembership, RESOLVE_NOW } from "./resolver-fixtures.ts";
import type { ResolverRuntime } from "../../src/resolver/http-handler.ts";

export const GROUP = "aaaaaaaa-0000-4000-8000-000000000007";
export const OTHER = "aaaaaaaa-0000-4000-8000-000000000008";
export const PERSON = "aaaaaaaa-0000-4000-8000-000000000009";
export const MODEL = "claude-sonnet-5";
export const NEW_MODEL = "claude-sonnet-5-5";
export const settings = () => ({
  schemaVersion: 1, tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
  clientId: "aaaaaaaa-0000-4000-8000-000000000002",
  scope: "api://aaaaaaaa-0000-4000-8000-000000000002/access_as_user",
  gatewayUrl: "https://gateway.example.test/ccof", projectHeaderName: "x-ccof-project",
  refreshMinutes: 2, desktop: { chat: true, cowork: true, code: true },
  deployments: [
    { backendId: activeMembership.backendId, id: MODEL, displayName: "Sonnet", createdAt: "2026-10-01T00:00:00Z" },
    { backendId: "another-backend", id: "claude-opus-5-5", displayName: "Other", createdAt: "2026-10-01T00:00:00Z" },
  ],
});
export function fixture() {
  const membership = {
    ...structuredClone(activeMembership), projectId: GROUP, classification: "group", classificationGroupId: GROUP,
    priority: 1, surfaces: ["code", "chat", "cowork"], chargebackId: null, restrictedFamiliesApproved: false,
  };
  const entitlement = { ...structuredClone(entitlementWithMembership), id: PERSON, personId: PERSON, projectMemberships: [membership] };
  const logs: string[] = [];
  const runtime: ResolverRuntime = {
    readiness: {
      ready: true, budgetEnforcement: { mode: "token-limits-only" }, requestDeadlineMs: 2000,
      reads: fakeReads({ readEntitlement: async () => entitlement }),
    },
    now: () => RESOLVE_NOW, log: (line) => logs.push(line),
  };
  const request = (representation = "bootstrap") => ({
    platformAuthEnabled: true, authenticatedPrincipal: true,
    body: { personId: PERSON, requestId: "test-request", representation },
  });
  return { runtime, membership, entitlement, logs, request };
}
