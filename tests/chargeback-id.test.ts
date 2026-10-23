// Chargeback ID in the ledger, the workbook and the console (ADR-0034 decision 7, ROADMAP G7a):
// usage rows carry the group's chargeback ID at request time; a view lists it per developer; the
// console can filter by it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWorkbook } from "../analytics/workbooks/build.ts";
import { buildChargebackWorkbook } from "../analytics/workbooks/chargeback.ts";
import { chargebackQueries } from "../analytics/workbooks/chargeback-queries.ts";
import { renderQuery } from "../analytics/workbooks/render.ts";
import { workbookAnswers } from "./helpers/workbook-fixtures.ts";

const card = JSON.parse(readFileSync(new URL("../config/rate-card.json", import.meta.url), "utf8"));
const ledger = readFileSync(new URL("../analytics/ledger.kql", import.meta.url), "utf8");
const groups = [{ projectId: "P1", classification: "STD", groupId: "6f3a2c1e-4b5d-4e8f-9a0b-1c2d3e4f5a6b", displayName: "P1 std" }];
const reporting = { ...card, entries: card.entries.filter((e: { model: string }) => !/^claude-(fable|mythos)/.test(e.model)) };

test("the ledger exposes a validated chargeback ID and surface from the usage trace", () => {
  // string or guid: Kusto types a GUID-shaped chargeback ID as guid (tests/ledger-guid-fields.test.ts).
  assert.match(ledger, /chargebackId = iff\(traceKnown and gettype\(payload\.chargebackId\) in \("string", "guid"\)/);
  assert.match(ledger, /matches regex @"\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/-\]\{0,63\}\$"/);
  assert.match(ledger, /surface = iff\(traceKnown and payload\.surface in \("chat", "code", "cowork", "design", "m365"\)/);
  assert.match(ledger, /\| project [^;]*\bchargebackId, surface\b/);
});

test("the workbook lists the chargeback ID per developer", () => {
  const workbook = buildChargebackWorkbook(workbookAnswers(), card, ledger, groups);
  const query = (workbook.queries as Record<string, string>).chargebackIds;
  assert.ok(query, "chargebackIds view");
  assert.match(query, /by chargebackId, person/);
  assert.match(JSON.stringify(workbook.workbook), /Per user tag \(chargeback ID\) and developer/);
  assert.doesNotMatch(query, /\{Chargeback:base64\}/, "the workbook has no chargeback parameter");
});

test("the console filters by chargeback ID; an empty ID is reported as (none)", () => {
  const base = buildWorkbook(workbookAnswers(), reporting, ledger);
  const extended = chargebackQueries(base, 500, groups, { extendedFilters: true });
  assert.match(extended.developers, /let ChargebackFilter = base64_decode_tostring\("\{Chargeback:base64\}"\);/);
  assert.match(extended.developers, /\(ChargebackFilter == "\*" or chargebackId == ChargebackFilter\)/);
  assert.match(extended.chargebackIds, /chargebackId = iff\(isempty\(chargebackId\), "\(none\)", chargebackId\)/);
  const rendered = renderQuery(extended.developers, { period: "month", project: "*", from: null, to: null, chargeback: "WBS-1" });
  assert.ok(rendered.includes(`base64_decode_tostring("${Buffer.from("WBS-1").toString("base64")}")`));
  assert.ok(renderQuery(extended.developers, { period: "month", project: "*", from: null, to: null }).includes('base64_decode_tostring("Kg==")'));
});
