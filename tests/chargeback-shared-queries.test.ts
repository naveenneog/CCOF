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
  // Changes with analytics/ledger.kql, which the workbook embeds (2026-10-24: GUID-typed fields, get-my-usage).
  assert.equal(chargeback.contentSha256, "42e734dc31aab7fee0caa55ee7842367f73f2930873f4df180879cdf757a53d2");
  assert.equal(workbook.contentSha256, "05d286e7d53dcc17440d80bc9e1c4323c73c0d13771bf68dbc91f5fa3713ecdc");
  assert.deepEqual(Object.fromEntries(Object.entries(chargeback.queries).map(([k, v]) => [k, sha(v as string)])), {
    health: "f1cc98e154a41e83a0619ae080033fa8b6eaa100b579f3fabdd50cad6f04af37",
    developers: "0866a81270d2ebd91d8bf1e5345395e4256b93a373607cfd5bdd328527094906",
    usage: "d635b3e97d4306c702994cc9f84189e7a7dad623d20ca5a155bc2a2286507891",
    groups: "903b22affe38eac2d994d2f50e4e69e73d5f76b02bc05696992d87d5c7fdbd81",
    chargebackIds: "2a603ccd08ec6ea0d8378fc63027b9b3a7c981da240b5f0b4e926da43ef74f2c",
    models: "108cf84ab47ea3591a598a3dd5252b0deb07b8dfe8cbb8111100d28ade098523",
    families: "5ff2a67e8c3d71f03606f3db63dd6a744829029688dd554a1061e9f5526f7b09",
    totals: "24fdb76e56059b80f0a5cf0c664ce8077b9e75918b84521c7d16a12e0adf9929",
    trends: "7726dd9ef542e9b3e64b7daba0263d85f25508dbe4cbf0a3d3ee5fda72cae871",
    diagnostics: "546d89cd89ef33efb4ea34e43c21f19a8dcf438b61c661e530d57c9797e5f7e5",
    unpriced: "caa12e461f44db0ab6f138d61260820c507516127f936477f92a6a4f62792ffb",
  });
});

test("the developers view shows each developer's user tags, (none) when a request carried none (owner decision 2026-10-23)", async () => {
  const { buildChargebackWorkbook } = await import("../analytics/workbooks/chargeback.ts");
  const developers = buildChargebackWorkbook(workbookAnswers(), card, ledger, groups).queries.developers as string;
  assert.match(developers, /chargebackId = iff\(isempty\(chargebackId\), "\(none\)", chargebackId\)/);
  assert.match(developers, /userTagSet = make_set\(chargebackId, 8\),/);
  assert.match(developers, /\| extend userTag = strcat_array\(array_sort_asc\(userTagSet\), ", "\)\n\| project-away userTagSet/);
});
