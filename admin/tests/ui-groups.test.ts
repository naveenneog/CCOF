// The group onboarding form's pure logic (ADR-0034, ROADMAP G8): the console builds the request body,
// checks the fields before sending, and estimates a group's monthly ceiling. The server stays the
// authority (src/contracts/group-registration.ts); these checks only explain problems earlier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clearErrors, emptyGroupForm, formFromDoc, formProblems, formToBody, groupEstimate } from "../ui-v3/lib/groups.ts";
import { readGroupRegistration } from "../../src/contracts/group-registration.ts";
import { toCsv } from "../ui-v3/lib/format.ts";
import { readFile } from "node:fs/promises";

const GROUP = "abcdef01-2345-4678-9abc-def012345678";
const unlimited = { tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null };
const policy = { aggregateLimits: { person: unlimited, group: unlimited }, families: { sonnet: { models: ["claude-sonnet-5"], person: unlimited, group: unlimited } } };

function filled() {
  return {
    ...emptyGroupForm(), groupId: GROUP, displayName: "Payments engineering", backendId: "backend01", priority: "20", chargebackId: "WBS-1234.01",
    perUserAmount: "50", currency: "USD" as const, mode: "cap" as const, capAmount: "500", surfaces: ["code", "chat"] as ("code" | "chat")[],
    policy, cacheReadPercent: "50", cacheBasis: "suggested" as const,
  };
}

test("a filled form becomes a body the server contract accepts", () => {
  const body = formToBody(filled());
  assert.deepEqual(body.budget, { mode: "cap", perUser: { amount: 50, currency: "USD", period: "monthly" }, groupCap: { amount: 500, currency: "USD", period: "monthly" } });
  assert.equal(body.priority, 20);
  assert.deepEqual(body.surfaces, ["code", "chat"]);
  const read = readGroupRegistration({ ...body, id: GROUP, kind: "group", projectId: GROUP, status: "active", retiredAt: null });
  assert.ok(read.ok, JSON.stringify(read));
});

test("autoScale sends no group cap; a blank chargeback ID is sent as null", () => {
  const body = formToBody({ ...filled(), mode: "autoScale", capAmount: "999", chargebackId: "  " });
  assert.equal((body.budget as { groupCap: unknown }).groupCap, null);
  assert.equal(body.chargebackId, null);
});

test("each field problem is named before sending", () => {
  assert.deepEqual(formProblems(filled()), {});
  const problems = formProblems({ ...filled(), groupId: "", chargebackId: "WBS 1", priority: "0", perUserAmount: "-1",
    surfaces: [], cacheReadPercent: "120", policy: { ...policy, families: {} } });
  assert.deepEqual(Object.keys(problems).sort(), ["cacheReadPercent", "chargebackId", "families", "groupId", "perUserAmount", "priority", "surfaces"]);
  const cap = formProblems({ ...filled(), perUserAmount: "50", capAmount: "10" });
  assert.deepEqual(Object.keys(cap), ["capAmount"]);
  assert.match(cap.capAmount, /at least the per-user budget/);
  assert.deepEqual(Object.keys(formProblems({ ...filled(), capAmount: "" })), ["capAmount"]);
});

test("the estimate shows what auto-scale and a cap mean for the current members", () => {
  assert.deepEqual(groupEstimate(filled(), 42), { perUser: 50, members: 42, uncapped: 2100, ceiling: 500, currency: "USD", capBinds: true });
  assert.deepEqual(groupEstimate({ ...filled(), mode: "autoScale" }, 42), { perUser: 50, members: 42, uncapped: 2100, ceiling: 2100, currency: "USD", capBinds: false });
  assert.deepEqual(groupEstimate({ ...filled(), capAmount: "5000" }, 42), { perUser: 50, members: 42, uncapped: 2100, ceiling: 2100, currency: "USD", capBinds: false });
  assert.equal(groupEstimate(filled(), null), null);
});

test("editing a field clears its error, and only its error", () => {
  const errors = { chargebackId: "x", priority: "y", families: "z", capAmount: "w" };
  assert.deepEqual(clearErrors(errors, { chargebackId: "WBS-1" }), { priority: "y", families: "z", capAmount: "w" });
  assert.deepEqual(clearErrors(errors, { policy }), { chargebackId: "x", priority: "y", capAmount: "w" });
  assert.deepEqual(clearErrors(errors, { mode: "autoScale" }), { chargebackId: "x", priority: "y", families: "z" });
});

test("a stored group fills the edit form, and the form round-trips", () => {
  const body = formToBody(filled());
  const doc = { ...body, id: GROUP, kind: "group", projectId: GROUP, status: "active", retiredAt: null };
  assert.deepEqual(formToBody(formFromDoc(doc)), body);
});

test("the console refuses the names the server refuses, and its CSV neutralises the same formula triggers (ADMIN-5)", () => {
  for (const displayName of [" ", "\t=1+1", "a\r\n=1+1", "\u200B", "Eng\u202EgnE", "x\u2066y"]) assert.ok(formProblems({ ...filled(), displayName }).displayName, JSON.stringify(displayName));
  assert.equal(formProblems({ ...filled(), displayName: "Payments – Zürich" }).displayName, undefined);
  const csv = toCsv(["v"], [{ v: " =1+1" }, { v: "\uFF1D1" }, { v: "\u200B=1+1" }, { v: "plain" }], {});
  assert.equal(csv, "\nv\n' =1+1\n'\uFF1D1\n'\u200B=1+1\nplain\n");
});

test("a malformed group link gets a plain explanation, not a retry of route_not_found (ADMIN-7)", async () => {
  const groups = await import("../ui-v3/lib/groups.ts");
  const { ApiFailure, errorMessage } = await import("../ui-v3/lib/api.ts");
  assert.match(groups.groupLinkProblem("onboard") ?? "", /not a group ID/);
  assert.equal(groups.groupLinkProblem(GROUP), null);
  assert.equal(groups.groupLinkProblem(GROUP.toUpperCase()), null);
  assert.match(errorMessage(new ApiFailure(404, { error: "group_not_found" })), /No onboarded group/);
  const page = await readFile(new URL("../ui-v3/pages/group-detail.tsx", import.meta.url), "utf8");
  assert.match(page, /groupLinkProblem\(id\)/);
  assert.match(page, /retry=\{doc\.error\.status === 404 \? undefined : doc\.reload\}|status === 404/);
});

test("the onboarding form names the deployment's backends and the models deployed on the chosen one (ADMIN-1)", async () => {
  const { deploymentProblems } = await import("../ui-v3/lib/groups.ts");
  const backends = [{ id: "backend01", deployments: ["claude-haiku-4-5", "claude-sonnet-5"] }, { id: "backend02", deployments: ["claude-opus-5"] }];
  assert.deepEqual(deploymentProblems(filled(), backends), {});
  assert.match(deploymentProblems({ ...filled(), backendId: "nope" }, backends).backendId ?? "", /backend01, backend02/);
  const moved = deploymentProblems({ ...filled(), backendId: "backend02" }, backends);
  assert.match(moved.families ?? "", /claude-sonnet-5.*not deployed on backend02.*claude-opus-5/);
  assert.match(deploymentProblems(filled(), null).backendId ?? "", /ADMIN_BACKENDS/, "no list: say why onboarding will be refused");
  const page = await readFile(new URL("../ui-v3/pages/group-onboard.tsx", import.meta.url), "utf8");
  assert.match(page, /useQuery[^\n]*"\/api\/groups\/backends"/);
  assert.doesNotMatch(page, /Type the APIM backend ID/);
});