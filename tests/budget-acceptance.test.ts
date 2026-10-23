import assert from "node:assert/strict";
import { test } from "node:test";
import { attr, descendants, parseApimXml } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { readGroupRegistration } from "../src/contracts/group-registration.ts";
import { budgetPeriodAt } from "../src/reconciler/period.ts";
import type { LedgerRow } from "../src/reconciler/ledger.ts";
import { classifyRow } from "../src/reconciler/price-rows.ts";
import { reconcile } from "../src/reconciler/reconcile.ts";
import { readRegistry } from "../src/reconciler/registry.ts";
import { resolveRequest } from "../src/resolver/decide.ts";
import type { ResolveContext } from "../src/resolver/decide.ts";
import { handleResolveRequest } from "../src/resolver/http-handler.ts";
import { planSync } from "../src/sync/plan.ts";
import { readProjectDocument } from "../src/sync/projects.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { GROUP_A, GROUP_B, groupDoc } from "./helpers/group-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";
import { PERSON_A, PERSON_B, ledgerRow, packagedRateCard, packagedSchedule } from "./helpers/reconciler-fixtures.ts";
import { fakeReads } from "./helpers/resolver-fixtures.ts";

const now = new Date("2026-10-23T12:00:00Z");
const card = packagedRateCard();
const schedule = packagedSchedule(card);
const period = budgetPeriodAt(now);
const dollarBudget = (amount: string) => ({ amount, currency: "USD", period: "monthly" });
const policy = groupDoc().familyPolicy;
assert.ok(policy && typeof policy === "object" && "families" in policy);
const groupPolicy = structuredClone(policy);
assert.ok(groupPolicy.families && typeof groupPolicy.families === "object");
delete (groupPolicy.families as Record<string, unknown>).sonnet;
const ctx: ResolveContext = { now,
  budgetEnforcement: { mode: "budget-state", staleness: { graceSeconds: 0, hardLimitSeconds: 0 }, requireCompleteUsage: true } };
const elements = descendants(parseApimXml(renderPolicy(sampleConfig() as GatewayConfig).policyXml));
const expression = (name: string, last = false) => {
  const matches = elements.filter((e) => e.name === "set-variable" && attr(e, "name") === name);
  assert.ok(matches.length, name);
  return attr(last ? matches.at(-1)! : matches[0], "value")!;
};

function setup(aRequests: number, bRequests = 0, partial = false) {
  const docs = [GROUP_A, GROUP_B].map((id, index) => groupDoc(id, {
    priority: index + 1, familyPolicy: groupPolicy,
    budget: { mode: "cap", perUser: dollarBudget("10"), groupCap: dollarBudget("20") },
  }));
  for (const doc of docs) assert.equal(readGroupRegistration(doc).ok, true);
  const sync = planSync({
    projects: docs.map(readProjectDocument), existing: [], memberTypes: ["user"],
    groups: new Map(docs.map((d) => [String(d.id), { ok: true as const, groupId: String(d.id),
      members: [{ id: PERSON_A, kind: "user" as const }, { id: PERSON_B, kind: "user" as const }], pages: 1, retries: 0 }])),
    removalLimits: { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 }, now,
  });
  assert.equal(sync.writes.length, 2);
  const entitlements = sync.writes.map((w) => w.document);
  const rows = [GROUP_A, GROUP_B].flatMap((projectId, i) =>
    Array.from({ length: i ? bRequests : aRequests }, () => classifyRow(ledgerRow({
      timestamp: "2026-10-23T11:55:00Z", ingestedAt: "2026-10-23T11:56:00Z", projectId,
      classification: "group", personId: PERSON_A, model: "claude-haiku-4-5",
      input: 100000, output: 0, cacheRead: partial ? null : 0, cacheWrite5m: 0, cacheWrite1h: 0, inferenceGeo: "global",
    }) as LedgerRow, period, card, schedule)));
  const result = reconcile({ registry: readRegistry(docs, entitlements), rows, rateCard: card,
    contractScheduleVersion: schedule.version, period, computedAt: now, validUntil: new Date(now.getTime() + 600000) });
  assert.deepEqual(result.problems, []);
  const deps = fakeReads({
    readEntitlement: async (personId: string) => entitlements.find((e) => e.personId === personId) ?? null,
    readBudgetState: async (personId: string, projectId: string) =>
      result.persons.find((p) => p.doc.personId === personId && p.doc.projectId === projectId)?.doc ?? null,
    readAggregateBudgetState: async (scopeId: string) => result.groups.find((g) => g.doc.scopeId === scopeId)?.doc ?? null,
  });
  return { result, deps };
}

test("$10 exact-priced boundary is enforced after reconciliation; selecting a nonmember group never grants access", async () => {
  for (const [requests, exhausted] of [[99, false], [100, true], [101, true]] as const) {
    const { result, deps } = setup(requests);
    const own = result.persons.find((p) => p.doc.personId === PERSON_A && p.doc.projectId === GROUP_A)!.doc;
    assert.equal(own.spentCcu, String(requests * 10));
    assert.equal(own.budgetCcu, "1000");
    const admission = await resolveRequest({ personId: PERSON_A }, deps, ctx);
    assert.equal(admission.refused, exhausted);
    if (exhausted) {
      assert.ok(admission.refused);
      assert.equal(admission.reason, "budget_exhausted");
    }
    const outsider = await resolveRequest({ personId: PERSON_A, projectId: "77777777-7777-4777-8777-777777777777" }, deps, ctx);
    assert.ok(outsider.refused);
  }
});

test("real sync and reconciler data select the higher-spend group, refuse its exhaustion, and keep explicit budgets separate", async () => {
  for (const aRequests of [80, 100]) {
    const { deps } = setup(aRequests, 20);
    const automatic = await resolveRequest({ personId: PERSON_A }, deps, ctx);
    if (aRequests === 80) {
      assert.ok(!automatic.refused);
      assert.equal(automatic.projectId, GROUP_A);
    } else {
      assert.ok(automatic.refused);
      assert.equal(automatic.reason, "budget_exhausted");
    }
    const explicit = await resolveRequest({ personId: PERSON_A, projectId: GROUP_B }, deps, ctx);
    assert.ok(!explicit.refused);
    assert.equal(explicit.projectId, GROUP_B, "an entitled second group has its own balance, not a person-wide $10 cap");
  }
});

test("group onboarding's exact family list reaches actual APIM model admission unchanged", async () => {
  const { deps } = setup(1);
  const d = await resolveRequest({ personId: PERSON_A }, deps, ctx);
  assert.ok(!d.refused);
  const models = ["claude-haiku-4-5", "claude-sonnet-5", "CLAUDE-HAIKU-4-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5 ", "team-alias"];
  const results = runExpressions({ Family: expression("ccofModelFamily", true) }, models.map((model) => ({
    label: model, method: "Family", vars: { ccofFamilyPolicy: d.familyPolicy, ccofClassification: "group",
      ccofRestrictedFamiliesApproved: false, ccofModel: model }, expected: model === models[0] ? "haiku" : "",
  })));
  assert.deepEqual(results, ["haiku", "", "", "", "", ""]);
});

test("fresh partial streamed accounting becomes a classified 503, not APIM last-known-good fallback, when opted in", async () => {
  const { deps } = setup(1, 0, true);
  const response = await handleResolveRequest({ platformAuthEnabled: true, authenticatedPrincipal: true,
    body: { personId: PERSON_A, projectId: GROUP_A } }, {
    readiness: { ready: true, budgetEnforcement: ctx.budgetEnforcement, requestDeadlineMs: 5000, reads: deps },
    now: () => now, log: () => {},
  });
  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.budgetState, "stale");
  const [normalized] = runExpressions({ Resolve: expression("ccofResolverResult") }, [{
    label: "incomplete accounting refusal", method: "Resolve", vars: { ccofResolverResponse: { status: response.status, body: response.jsonBody } },
    json: true, expected: null,
  }]) as Array<Record<string, unknown>>;
  assert.equal(normalized.o, "refuse");
  assert.equal(normalized.c, "budget_state_unavailable");
});
