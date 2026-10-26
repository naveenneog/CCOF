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
  // Changes with analytics/ledger.kql, which the workbook embeds (2026-10-24: GUID-typed fields, get-my-usage; 2026-10-26: backend refusals priced at zero, ADR-0048).
  assert.equal(chargeback.contentSha256, "4c2f3e77796909ddddc628116ac7d9b6e3f681b7984e3d126429b25c2e6ecd00");
  assert.equal(workbook.contentSha256, "dcfb9e56aec09789e39c9a625c2ed15afeeafa60d68c35a0c4a9afd6b47c77de");
  assert.deepEqual(Object.fromEntries(Object.entries(chargeback.queries).map(([k, v]) => [k, sha(v as string)])), {
    health: "dcfb89182f8e0941c94b1cd27afb77d6703c40bb1f6af1bb82920f4887282522",
    developers: "ef474d92ece856bc53a4996d33c5e05aa912f25228826551e837bfae12816122",
    usage: "e699bbb58515aa0b79cd4456f95ba2dd3856498970d3425c3072c469f6b9b438",
    groups: "dc50a2fefe159de5e9f3da5e2b88e1b8412d58ad556ad0ea8edc622a0a6edaff",
    chargebackIds: "33bc7b7288f3349afe99349c89e5c06344d6824630d7a8afc6e1dccded7873a6",
    models: "282554f579e1c760ff9eb020dc31ff1dcf6d646aae2cb5b50644e04d16aab70a",
    families: "89c064a9bd7b0fd82f0fb9b087dd7bd17ce7b27d02c349dc8166f636c4b00726",
    totals: "028c894c6179867967e4665cc9a2cb62cdeeb17ae489086a055636ae50deef5f",
    trends: "f6a7ccfe2a50c227cd91dcc50f555ec3df0788727750ca363b485c9b6a95c0f8",
    diagnostics: "85375e97181027930bf162182cec6c82d186b1ec774b6fd472bedea0832f1276",
    unpriced: "766fa553bc547805474dcee8c487065f103f337334e0e44e7980f6bec8d702bd",
  });
});

test("the developers view shows each developer's user tags, (none) when a request carried none (owner decision 2026-10-23)", async () => {
  const { buildChargebackWorkbook } = await import("../analytics/workbooks/chargeback.ts");
  const developers = buildChargebackWorkbook(workbookAnswers(), card, ledger, groups).queries.developers as string;
  assert.match(developers, /chargebackId = iff\(isempty\(chargebackId\), "\(none\)", chargebackId\)/);
  assert.match(developers, /userTagSet = make_set\(chargebackId, 8\),/);
  assert.match(developers, /\| extend userTag = strcat_array\(array_sort_asc\(userTagSet\), ", "\)\n\| project-away userTagSet/);
});
