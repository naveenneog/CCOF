import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { pseudoText, leaks, pseudonymisePage, capturePseudonymised } = require("./playwright/pseudonymise.cjs");
const cfg = {
  salt: "documentation-test-only",
  keep: ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"],
  literalsSorted: [["operator@example.test", "alex.admin@contoso.com"], ["XY", "AA", "word"]],
  leakTokens: ["private-tenant"],
};

test("capture pseudonyms preserve GUID format, identity, case and public application IDs", () => {
  const real = "12345678-abcd-4321-9876-123456789abc";
  const fake = pseudoText(real, cfg);
  assert.match(fake, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(fake, real);
  assert.equal(pseudoText(real, cfg), fake);
  assert.equal(pseudoText(real.toUpperCase(), cfg), fake.toUpperCase());
  assert.notEqual(pseudoText("87654321-abcd-4321-9876-123456789abc", cfg), fake);
  assert.equal(pseudoText(cfg.keep[0], cfg), cfg.keep[0]);
  assert.equal(pseudoText("OPERATOR@example.test XY XYZ xy", cfg), "alex.admin@contoso.com AA XYZ xy");
  assert.equal(leaks("private-tenant", cfg).length, 1);
  assert.equal(leaks("operator@example.test", cfg).length, 1);
  assert.deepEqual(leaks("alex.admin@contoso.com", cfg), []);
});

test("a capture refuses remaining real values before writing a screenshot", async () => {
  let captures = 0;
  const page = {
    frames: () => [{ evaluate: async () => "private-tenant" }],
    screenshot: async () => { captures++; },
  };
  await assert.rejects(() => capturePseudonymised(page, cfg, { path: "unused.png" }), /real values remain/);
  assert.equal(captures, 0);
});

test("capture preparation propagates frame failures instead of publishing unchecked pixels", async () => {
  const page = { frames: () => [{ evaluate: async () => { throw new Error("frame unavailable"); } }] };
  await assert.rejects(() => pseudonymisePage(page, cfg), /frame unavailable/);
});

test("a clean multi-frame capture is written once", async () => {
  let captures = 0;
  const page = {
    frames: () => [{ evaluate: async () => "Alex Admin" }, { evaluate: async () => "Contoso" }],
    screenshot: async () => { captures++; },
  };
  await capturePseudonymised(page, cfg, { path: "unused.png" });
  assert.equal(captures, 1);
});

test("consecutive captures keep the same pseudonym and restore live DOM values even on screenshot failure", async () => {
  const real = "12345678-abcd-4321-9876-123456789abc";
  const node = { nodeValue: real };
  const input = { value: "operator@example.test" };
  const document = {
    body: { get innerText() { return node.nodeValue; } },
    createTreeWalker: () => {
      let pending = true;
      return { nextNode: () => pending ? (pending = false, node) : null };
    },
    querySelectorAll: (selector: string) => selector === "input, textarea" ? [input] : [],
  };
  const context = vm.createContext({ document, NodeFilter: { SHOW_TEXT: 4 } });
  const frame = { evaluate: async (source: string | (() => unknown)) =>
    vm.runInContext(typeof source === "string" ? source : `(${source.toString()})()`, context) };
  const captures: string[] = [];
  let failScreenshot = false;
  const page = {
    frames: () => [frame],
    screenshot: async () => {
      if (failScreenshot) throw new Error("capture failed");
      captures.push(node.nodeValue);
      assert.equal(input.value, "alex.admin@contoso.com");
    },
  };
  await capturePseudonymised(page, cfg, {});
  await capturePseudonymised(page, cfg, {});
  assert.deepEqual(captures, [pseudoText(real, cfg), pseudoText(real, cfg)]);
  assert.equal(node.nodeValue, real);
  assert.equal(input.value, "operator@example.test");
  failScreenshot = true;
  await assert.rejects(() => capturePseudonymised(page, cfg, {}), /capture failed/);
  assert.equal(node.nodeValue, real);
  assert.equal(input.value, "operator@example.test");
});
