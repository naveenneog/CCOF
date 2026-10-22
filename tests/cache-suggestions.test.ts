// Cache-read suggesters per surface (ADR-0034 decision 8, UNKNOWNS G-R1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_SUGGESTIONS, suggestCacheReadPercent } from "../src/contracts/cache-suggestions.ts";

test("each surface states its suggestion, its evidence class and a source", () => {
  assert.deepEqual(Object.keys(CACHE_SUGGESTIONS).sort(), ["chat", "code", "cowork", "design", "m365"]);
  for (const [surface, s] of Object.entries(CACHE_SUGGESTIONS)) {
    if (s.percent === null) {
      assert.equal(s.basis, "none", surface);
      continue;
    }
    assert.ok(["illustrative", "analogue", "assumed"].includes(s.basis), surface);
    assert.match(s.source, /^https:\/\//, surface);
    assert.ok(s.percent >= 0 && s.percent <= 100, surface);
  }
  assert.equal(CACHE_SUGGESTIONS.design.percent, null);
});

test("no suggestion claims a published average: none exists for these surfaces", () => {
  for (const s of Object.values(CACHE_SUGGESTIONS)) assert.notEqual(s.basis as string, "published");
});

test("a group's suggestion is the lowest across its enabled surfaces and carries its evidence class", () => {
  assert.deepEqual(suggestCacheReadPercent(["code"]), { percent: 85, from: [{ surface: "code", basis: "illustrative" }] });
  assert.deepEqual(suggestCacheReadPercent(["code", "chat"]), { percent: 50, from: [{ surface: "chat", basis: "assumed" }] });
  assert.deepEqual(suggestCacheReadPercent(["code", "m365"]), { percent: 60, from: [{ surface: "m365", basis: "assumed" }] });
});

test("a surface the gateway does not carry (cowork) never sets the suggestion", () => {
  assert.equal(CACHE_SUGGESTIONS.cowork.gatewayRouted, false);
  assert.deepEqual(suggestCacheReadPercent(["code", "cowork"]), { percent: 85, from: [{ surface: "code", basis: "illustrative" }] });
  assert.equal(suggestCacheReadPercent(["cowork"]), null);
});

test("surfaces with no suggestion are ignored; with none left there is no suggestion", () => {
  assert.deepEqual(suggestCacheReadPercent(["design", "code"]), { percent: 85, from: [{ surface: "code", basis: "illustrative" }] });
  assert.equal(suggestCacheReadPercent(["design"]), null);
  assert.equal(suggestCacheReadPercent([]), null);
});

test("a repeated surface is counted once", () => {
  assert.deepEqual(suggestCacheReadPercent(["chat", "chat"]), { percent: 50, from: [{ surface: "chat", basis: "assumed" }] });
});
