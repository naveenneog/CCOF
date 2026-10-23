import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { workbookAnswers } from "./helpers/workbook-fixtures.ts";

// The admin console V3 and the chargeback workbook share one query builder
// (analytics/workbooks/chargeback-queries.ts). These digests were recorded from the workbook build
// before that refactor; matching them proves the refactor left the deployed workbook content and
// every query unchanged. A deliberate change to the report, ledger or rate card updates them.
const card = JSON.parse(readFileSync(new URL("../config/rate-card.json", import.meta.url), "utf8"));
const ledger = readFileSync(new URL("../analytics/ledger.kql", import.meta.url), "utf8");
const groups = [{ projectId: "P1", classification: "STD", groupId: "6f3a2c1e-4b5d-4e8f-9a0b-1c2d3e4f5a6b", displayName: "P1 std" }];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("the shared query builder leaves the chargeback and fixed-price workbooks byte-for-byte unchanged", async () => {
  const { buildChargebackWorkbook } = await import("../analytics/workbooks/chargeback.ts");
  const { buildWorkbook } = await import("../analytics/workbooks/build.ts");
  const chargeback = buildChargebackWorkbook(workbookAnswers(), card, ledger, groups);
  const workbook = buildWorkbook(workbookAnswers(), card, ledger);
  assert.equal(chargeback.contentSha256, "dc129b8d8d8b856800b5182fbd78d87b3bd74bff64b18f7b2697e373029dc67c");
  assert.equal(workbook.contentSha256, "9e34609656413f7c47a2d925acecfea6f7b1722042d9f67a587e3a77ab4bcb27");
  assert.deepEqual(Object.fromEntries(Object.entries(chargeback.queries).map(([k, v]) => [k, sha(v as string)])), {
    health: "60634e89dbccfcb4d2185110a7f8bc626ee11ad59607bfd05834880f711cff78",
    developers: "b2aa8418d9973170f11b1f7311217f983353c391720ead5d2b8dbcbf4ac4b5b1",
    usage: "396f39df885dda69c1c6855ae467c951fae27b8b62ba6f87de1945d12fa39cae",
    groups: "c1de3a804f2f4a11aa1f331bc29be4453accc6c2c52fd8eab8a3f3bd70d6add4",
    chargebackIds: "f47b0bd9321d4c59e28dc695762a63652462ab01b2aa77ee4557b5ed4115735e",
    models: "eaa469c16be4ec5b593a9154cc52b5b3e9db3a00baa14f5c3af49c388af8ae89",
    families: "b6d73b7f34c91c87d817cdda9814f47afcc9e77dd2de6e4574273533972c7d0f",
    totals: "28e27c35517bc7c28b26767e9815dfb669b516db61b7535ddbf50f82e4702fa5",
    trends: "1f0590b5bece8cac0de0baff46eaf151449d47b92a3a30846984fd6e0be297cd",
    diagnostics: "0cf642d6ab0bd02241196dce8d19cb5b32a1730ca9423c78770694d2797587c0",
    unpriced: "d7bba093e0304ff2616f4d1e49a698902f403ac3b826b7b04bfcc530f9256081",
  });
});

test("the developers view shows each developer's user tags, (none) when a request carried none (owner decision 2026-10-23)", async () => {
  const { buildChargebackWorkbook } = await import("../analytics/workbooks/chargeback.ts");
  const developers = buildChargebackWorkbook(workbookAnswers(), card, ledger, groups).queries.developers as string;
  assert.match(developers, /chargebackId = iff\(isempty\(chargebackId\), "\(none\)", chargebackId\)/);
  assert.match(developers, /userTagSet = make_set\(chargebackId, 8\),/);
  assert.match(developers, /\| extend userTag = strcat_array\(array_sort_asc\(userTagSet\), ", "\)\n\| project-away userTagSet/);
});
