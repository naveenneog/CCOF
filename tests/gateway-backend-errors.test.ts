import assert from "node:assert/strict";
import { test } from "node:test";
import { attr, descendants, parseApimXml, textOf, type XmlElement } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";

const root = parseApimXml(renderPolicy(sampleConfig() as GatewayConfig).policyXml);
const outbound = root.children.find((n): n is XmlElement => n.kind === "element" && n.name === "outbound")!;
const all = descendants(outbound);
const expression = () => {
  const variable = all.find((e) => e.name === "set-variable" && attr(e, "name") === "ccofBackendErrorBody");
  assert.ok(variable, "backend errors need an Anthropic envelope");
  return attr(variable, "value")!;
};

test("backend 429 names the shared Foundry deployment limit, not the person's limit", () => {
  const [body] = runExpressions({ Normalize: expression() }, [{
    label: "Azure throttle", method: "Normalize", status: 429, json: true, expected: null,
    vars: { ccofBackendErrorJson: '{"error":{"code":"RateLimitReached","message":"backend detail must not leak"}}' },
  }]) as Array<{ type: string; error: { type: string; message: string } }>;
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "rate_limit_error");
  assert.match(body.error.message, /shared Foundry deployment limit/i);
  assert.match(body.error.message, /not your personal/i);
  assert.doesNotMatch(body.error.message, /backend detail/);
});

test("non-Anthropic backend errors are wrapped; valid Anthropic errors stay intact", () => {
  const bodies = ['{"error":{"code":"BadRequest","message":"internal"}}', "<html>internal</html>", "", "null",
    '{"type":"error","error":{"type":7,"message":"wrong type"}}'];
  const outputs = runExpressions({ Normalize: expression() }, bodies.map((body, i) => ({
    label: `bad shape ${i}`, method: "Normalize", status: i === 1 ? 503 : 400, json: true, expected: null,
    vars: { ccofBackendErrorJson: body },
  }))) as Array<{ type: string; error: { type: string; message: string } }>;
  for (const [i, body] of outputs.entries()) {
    assert.equal(body.type, "error");
    assert.equal(body.error.type, i === 1 ? "api_error" : "invalid_request_error");
    assert.doesNotMatch(body.error.message, /internal|<html>/);
    assert.match(body.error.message, /Request id:/);
  }
  const [unchanged] = runExpressions({ Normalize: expression() }, [{
    label: "Anthropic shape", method: "Normalize", status: 400, expected: "",
    vars: { ccofBackendErrorJson: '{"type":"error","error":{"type":"invalid_request_error","message":"bad model"}}' },
  }]);
  assert.equal(unchanged, "", "empty replacement preserves the original response");
});

test("only failed backend responses enter the body-reading branch; status and Retry-After are preserved", () => {
  const when = all.find((e) => e.name === "when" && attr(e, "condition") === "@(context.Response.StatusCode >= 400)");
  assert.ok(when, "successful SSE responses must not enter an error-body policy");
  const guard = attr(when, "condition")!;
  assert.deepEqual(runExpressions({ ErrorBranch: guard }, [
    { label: "successful SSE", method: "ErrorBranch", status: 200, vars: { ccofStream: true }, expected: false },
    { label: "throttle on streamed request", method: "ErrorBranch", status: 429, vars: { ccofStream: true }, expected: true },
    { label: "finite backend error", method: "ErrorBranch", status: 400, expected: true },
  ]), [false, true, true]);
  const branch = descendants(when);
  const read = branch.find((e) => e.name === "set-variable" && attr(e, "name") === "ccofBackendErrorJson");
  assert.ok(read);
  assert.match(attr(read, "value")!, /Body.As<string>\(preserveContent: true\)/);
  assert.ok(branch.some((e) => e.name === "set-body" && textOf(e).includes("ccofBackendErrorBody")));
  assert.equal(branch.filter((e) => e.name === "set-status" || e.name === "return-response").length, 0);
  assert.equal(branch.filter((e) => e.name === "set-header" && attr(e, "name") === "Retry-After").length, 0);
});
