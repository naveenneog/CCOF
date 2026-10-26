// ADR-0048: requests the backend could only refuse are answered by the gateway, in Anthropic's error shape,
// before anything is forwarded or counted (bug bash GW-2, GW-3, GW-4). The C# expressions run compiled
// (tests/helpers/policy-csharp.ts).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { XmlElement } from "../infra/gateway/apim-xml.ts";
import { attr, descendants, parseApimXml, textOf } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions, type Vector } from "./helpers/policy-csharp.ts";

const root = parseApimXml(renderPolicy(sampleConfig() as GatewayConfig).policyXml);
const inbound = root.children.find((n): n is XmlElement => n.kind === "element" && n.name === "inbound")!;
const all = descendants(inbound);
const variable = (name: string) => {
  const found = all.filter((e) => e.name === "set-variable" && attr(e, "name") === name);
  assert.ok(found.length > 0, `no set-variable ${name}`);
  return found;
};
const methods = () => ({
  PathServed: attr(variable("ccofPathServed")[0], "value")!,
  RequestRefusal: attr(variable("ccofRequestRefusal")[0], "value")!,
  RequestFacts: attr(variable("ccofRequestFacts")[0], "value")!,
  RefusalStatus: attr(variable("ccofRefusalStatus")[0], "value")!,
  RefusalBody: attr(variable("ccofRefusalBody")[0], "value")!,
  Selector: attr(variable("ccofSelector")[0], "value")!,
  AllowedModels: attr(variable("ccofAllowedModels")[0], "value")!,
});

test("only the exact /v1/messages path is served: trailing slash, dot, empty segment and case variants are not", () => {
  const served = ["/anthropic/v1/messages", "/anthropic;rev=1/v1/messages", "/other-path/v1/messages"];
  const refused = ["/anthropic/v1/messages/", "/anthropic/v1/messages/.", "/anthropic/v1/messages//", "/anthropic/V1/Messages",
    "/anthropic/v1/Messages", "/anthropic//v1/messages", "/anthropic/./v1/messages", "/anthropic/../v1/messages",
    "/anthropic/v1/messages/count_tokens/..", "/v1/messages", "/anthropic/v1/messages;x", ""];
  const vectors: Vector[] = [...served.map((path) => ({ label: path, method: "PathServed", path, expected: true })),
    ...refused.map((path) => ({ label: path, method: "PathServed", path, expected: false }))];
  assert.deepEqual(runExpressions(methods(), vectors), vectors.map((v) => v.expected));
});

test("an unserved path is answered 404 not_found_error before the token check, with nothing forwarded", () => {
  const check = variable("ccofPathServed")[0];
  const jwt = all.find((e) => attr(e, "id") === "ccof-jwt")!;
  assert.ok(all.indexOf(check) < all.indexOf(jwt), "the path is checked before the token");
  const choose = all.find((e) => e.name === "choose" && e.children.some((c) => c.kind === "element" && attr(c, "condition") === '@(!(bool)context.Variables["ccofPathServed"])'))!;
  assert.ok(choose, "no branch on ccofPathServed");
  assert.ok(all.indexOf(choose) < all.indexOf(jwt), "the 404 leaves before the token check");
  const inBranch = descendants(choose);
  assert.deepEqual(inBranch.filter((e) => ["forward-request", "send-request", "llm-token-limit", "rate-limit-by-key", "trace"].includes(e.name)).map((e) => e.name), []);
  const response = inBranch.find((e) => e.name === "return-response")!;
  const status = inBranch.find((e) => e.name === "set-status")!;
  assert.equal(attr(status, "code"), "404");
  assert.equal(attr(status, "reason"), "Not Found");
  const headers = Object.fromEntries(inBranch.filter((e) => e.name === "set-header").map((e) => [attr(e, "name"), textOf(descendants(e).find((v) => v.name === "value")!).trim()]));
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(headers["x-ccof-request-id"]?.includes("context.RequestId"));
  const body = textOf(inBranch.find((e) => e.name === "set-body")!).trim();
  const [answer] = runExpressions({ Body: body }, [{ label: "body", method: "Body", json: true, expected: null }]) as Array<{ type: string; error: { type: string; message: string } }>;
  assert.equal(answer.type, "error");
  assert.equal(answer.error.type, "not_found_error");
  assert.match(answer.error.message, / Request id: 00000000-0000-0000-0000-000000000001\.$/);
  assert.ok(response);
});

test("a body that is not JSON, or larger than 32 MB, is refused from its headers", () => {
  const vector = (label: string, headers: Record<string, string>, expected: string): Vector => ({ label, method: "RequestRefusal", headers, expected });
  const json = { "Content-Type": "application/json" };
  const vectors = [
    vector("json", json, ""),
    vector("json with charset", { "Content-Type": "application/json; charset=utf-8" }, ""),
    vector("upper case", { "Content-Type": "Application/JSON" }, ""),
    vector("text/plain", { "Content-Type": "text/plain" }, "request_content_type"),
    vector("none", {}, "request_content_type"),
    vector("json-like", { "Content-Type": "application/jsonx" }, "request_content_type"),
    vector("32 MB exactly", { ...json, "Content-Length": "33554432" }, ""),
    vector("one byte over", { ...json, "Content-Length": "33554433" }, "request_too_large"),
    vector("40 MB", { ...json, "Content-Length": "40000000" }, "request_too_large"),
    vector("no length", json, ""),
  ];
  assert.deepEqual(runExpressions(methods(), vectors), vectors.map((v) => v.expected));
});

test("a header refusal skips reading the body, and is answered 415 or 413 in Anthropic's error shape", () => {
  const body = JSON.stringify({ model: "m", stream: false });
  const [read, skipped, s415, s413, b415, b413] = runExpressions(methods(), [
    { label: "read", method: "RequestFacts", vars: { ccofRefusal: "" }, body, expected: null },
    { label: "skipped", method: "RequestFacts", vars: { ccofRefusal: "request_too_large" }, body, expected: null },
    { label: "415", method: "RefusalStatus", vars: { ccofRefusal: "request_content_type" }, expected: null },
    { label: "413", method: "RefusalStatus", vars: { ccofRefusal: "request_too_large" }, expected: null },
    { label: "415 body", method: "RefusalBody", json: true, vars: { ccofRefusal: "request_content_type", ccofSelector: "", ccofModel: "" }, expected: null },
    { label: "413 body", method: "RefusalBody", json: true, vars: { ccofRefusal: "request_too_large", ccofSelector: "", ccofModel: "" }, expected: null },
  ]) as [string, string, number, number, { error: { type: string; message: string } }, { error: { type: string; message: string } }];
  assert.equal(JSON.parse(read).model, "m");
  assert.equal(skipped, "");
  assert.equal(s415, 415);
  assert.equal(s413, 413);
  assert.equal(b415.error.type, "invalid_request_error");
  assert.match(b415.error.message, /application\/json/);
  assert.equal(b413.error.type, "request_too_large");
  assert.match(b413.error.message, /32 MB/);
  const facts = variable("ccofRequestFacts")[0];
  const applied = variable("ccofRefusal").find((e) => attr(e, "value") === '@((string)context.Variables["ccofRequestRefusal"])');
  assert.ok(applied, "the header refusal is not applied");
  assert.ok(all.indexOf(applied) < all.indexOf(facts), "the header refusal is applied before the body is read");
  const reasons = all.filter((e) => e.name === "set-status").map((e) => attr(e, "reason") ?? "").join("\n");
  assert.match(reasons, /case 413: return "Content Too Large";/);
  assert.match(reasons, /case 415: return "Unsupported Media Type";/);
});

const GROUP = "4a5b6c7d-0000-4000-8000-000000000001";
const refusalBody = (vars: Record<string, unknown>) =>
  ({ label: JSON.stringify(vars), method: "RefusalBody", json: true, expected: null, vars: { ccofSelector: "", ccofModel: "", ...vars } });

test("a group Object ID in the project header is compared in lower case; other selectors are kept as sent", () => {
  const header = (sampleConfig() as GatewayConfig).resolver.projectHeaderName;
  const vectors: Vector[] = [
    { label: "upper", method: "Selector", headers: { [header]: GROUP.toUpperCase() }, expected: GROUP },
    { label: "mixed", method: "Selector", headers: { [header]: "4A5b6C7d-0000-4000-8000-000000000001" }, expected: GROUP },
    { label: "lower", method: "Selector", headers: { [header]: GROUP }, expected: GROUP },
    { label: "project id", method: "Selector", headers: { [header]: "CCOFPILOT02" }, expected: "CCOFPILOT02" },
    { label: "none", method: "Selector", headers: {}, expected: "" },
  ];
  assert.deepEqual(runExpressions(methods(), vectors), vectors.map((v) => v.expected));
});

test("the not-entitled message tells a missing membership, an unknown group ID and a value that is not a group ID apart", () => {
  const [none, guid, name] = (runExpressions(methods(), [
    refusalBody({ ccofRefusal: "not_authorized" }),
    refusalBody({ ccofRefusal: "not_authorized", ccofSelector: GROUP }),
    refusalBody({ ccofRefusal: "not_authorized", ccofSelector: "Engineering" }),
  ]) as Array<{ error: { type: string; message: string } }>).map((b) => b.error);
  for (const e of [none, guid, name]) assert.equal(e.type, "permission_error");
  assert.match(none.message, /not a member of a Claude group/);
  assert.match(guid.message, new RegExp(`not an active member of Claude group ${GROUP}`));
  assert.match(guid.message, /remove the header/);
  assert.doesNotMatch(guid.message, /add you to/);
  assert.match(name.message, /Object ID of one of your Claude groups/);
  assert.match(name.message, /not its name or chargeback ID/);
  assert.doesNotMatch(name.message, /add you to/);
});

test("a model refusal lists the group's allowed models in group wording", () => {
  const policy = { aggregateLimits: { person: {}, group: {} }, families: {
    sonnet: { models: ["claude-sonnet-5"] }, haiku: { models: ["claude-haiku-4-5", "claude-haiku-4-5-fast"] }, mythos: { models: ["claude-mythos-1"] } } };
  const [plain, approved, project] = runExpressions(methods(), [
    { label: "group", method: "AllowedModels", expected: null, vars: { ccofFamilyPolicy: policy, ccofClassification: "group", ccofRestrictedFamiliesApproved: false } },
    { label: "approved", method: "AllowedModels", expected: null, vars: { ccofFamilyPolicy: policy, ccofClassification: "group", ccofRestrictedFamiliesApproved: true } },
    { label: "project", method: "AllowedModels", expected: null, vars: { ccofFamilyPolicy: policy, ccofClassification: "STD" } },
  ]);
  assert.equal(plain, "claude-haiku-4-5, claude-haiku-4-5-fast, claude-sonnet-5");
  assert.equal(approved, "claude-haiku-4-5, claude-haiku-4-5-fast, claude-mythos-1, claude-sonnet-5");
  assert.equal(project, "claude-haiku-4-5, claude-haiku-4-5-fast, claude-sonnet-5");
  const [group, legacy, odd] = (runExpressions(methods(), [
    refusalBody({ ccofRefusal: "model_family_not_allowed", ccofModel: "claude-opus-5-5", ccofProjectId: GROUP, ccofClassification: "group", ccofAllowedModels: plain }),
    refusalBody({ ccofRefusal: "model_family_not_allowed", ccofModel: "claude-opus-5-5", ccofProjectId: "PILOT1", ccofClassification: "STD", ccofAllowedModels: plain }),
    refusalBody({ ccofRefusal: "model_family_not_allowed", ccofModel: "<script>", ccofProjectId: GROUP, ccofClassification: "group", ccofAllowedModels: plain }),
  ]) as Array<{ error: { type: string; message: string } }>).map((b) => b.error);
  assert.equal(group.type, "permission_error");
  assert.match(group.message, new RegExp(`Model claude-opus-5-5 is not available in group ${GROUP}\\.`));
  assert.match(group.message, /Allowed models: claude-haiku-4-5, claude-haiku-4-5-fast, claude-sonnet-5\./);
  assert.match(group.message, /\/model/);
  assert.doesNotMatch(group.message, /classification/);
  assert.match(legacy.message, /in project PILOT1\./);
  assert.doesNotMatch(odd.message, /<script>/);
  assert.match(odd.message, /^The requested model is not available/);
});
