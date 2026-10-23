// Checks a JSON array of projects documents with the registry seed's own check (src/sync/registry-seed.ts),
// so tests/Test-StagedStages.ps1 proves the staged deployment's group documents are seedable.
// Usage: node tests/helpers/check-group-documents.ts <file.json>. Exit 0 when every document passes.
import { readFileSync } from "node:fs";
import { checkSeedProjectDocument } from "../../src/sync/registry-seed.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: check-group-documents.ts <file.json>");
  process.exit(2);
}
const docs: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
if (!Array.isArray(docs) || docs.length === 0) {
  console.error("expected a non-empty JSON array");
  process.exit(2);
}
const problems = docs.flatMap((doc, i) => checkSeedProjectDocument(doc).map((p) => `[${i}] ${p}`));
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: ${docs.length} document(s)`);
