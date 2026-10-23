// Kusto's parse_json types a GUID-shaped string as guid (live Log Analytics, 2026-10-24:
// gettype(parse_json('{"a":"b1c0b485-15f0-4702-b5c1-81bfa40e6189"}').a) == "guid"). A group-centric
// onboarding uses the group's object ID as projectId, so a `== "string"` check dropped every group request
// from the ledger: attributionKnown false, no spend, no budget, no chargeback row (live Stage 8 + reconciler).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const files = ["analytics/ledger.kql", "analytics/budget-events.kql"].map((f) => [f, readFileSync(new URL(`../${f}`, import.meta.url), "utf8")] as const);
// Fields whose value can be a GUID: group IDs, and admin-entered identifiers that may be GUIDs.
const GUID_CAPABLE = ["projectId", "chargebackId", "backendId", "classificationGroupDisplayName"];

test("no ledger or budget-event field that can hold a GUID requires the dynamic type string alone", () => {
  for (const [file, text] of files) {
    for (const field of GUID_CAPABLE) {
      assert.doesNotMatch(text, new RegExp(`gettype\\(payload\\.${field}\\)\\s*==\\s*"string"`), `${file}: ${field}`);
    }
  }
});

test("projectId is read when Kusto types it as string or guid", () => {
  for (const [file, text] of files) {
    assert.match(text, /gettype\(payload\.projectId\) in \("string", "guid"\)/, file);
  }
});

// GET /ccof/me/usage (operation get-my-usage) answers from the gateway and never calls a model, but APIM's
// API-wide LLM diagnostic writes a row for it; the ledger listed each call as an unattributed request (live 2026-10-24).
test("the ledger treats the get-my-usage operation as a gateway-only answer, never usage", () => {
  const ledger = files[0][1];
  assert.match(ledger, /observedOperationId = tostring\(OperationId\)/);
  assert.match(ledger, /noBackendCall = [\s\S]*?observedOperationId =~ "get-my-usage"/);
});
