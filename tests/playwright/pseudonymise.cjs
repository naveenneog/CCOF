// Replaces real identifiers in documentation captures with consistent, realistic-looking hypothetical ones.
// The mapping file (kept private, never committed) holds:
//   { "salt": "<random>", "keepGuids": ["04b07795-8ddb-461a-bbee-02f9e1bf7b46", ...], "literals": [["real", "fake"], ...] }
// - literals: replaced case-insensitively, longest first (tenant, account, subscription, group and app names);
// - every GUID not in keepGuids becomes a deterministic fake GUID of the same format (same input, same output, so
//   one object has one ID across every screenshot); keepGuids are public, well-known IDs (Azure CLI, Graph).
// The functions below are self-contained so they can run inside a browser page (page.evaluate with a string).
'use strict';

function pseudoText(text, cfg) {
  if (typeof text !== 'string' || !text) return text;
  const h32 = (s, seed) => { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 2654435761); h = (h << 13) | (h >>> 19); } h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0'); };
  const fakeGuid = (g) => {
    const k = `${cfg.salt}|${g.toLowerCase()}`;
    const x = h32(k, 1) + h32(k, 2) + h32(k, 3) + h32(k, 4);
    const v = `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-${'89ab'[parseInt(x[16], 16) % 4]}${x.slice(17, 20)}-${x.slice(20, 32)}`;
    return g === g.toUpperCase() ? v.toUpperCase() : v;
  };
  let out = text;
  for (const [real, fake, mode] of cfg.literalsSorted) {
    if (!real) continue;
    const esc = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // mode "word": whole word, exact case (for short values such as avatar initials).
    out = mode === 'word' ? out.replace(new RegExp(`\\b${esc}\\b`, 'g'), fake) : out.replace(new RegExp(esc, 'gi'), fake);
  }
  return out.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    (g) => (cfg.keep.includes(g.toLowerCase()) ? g : fakeGuid(g)));
}

function loadConfig(file) {
  const raw = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  if (!raw.salt || raw.salt.length < 16) throw new Error('pseudonym mapping needs a salt of 16+ characters');
  // A literal with backslashes also appears JSON-escaped (C:\\Users\\...) and with forward slashes (C:/Users/...).
  const literals = (raw.literals || []).filter(([r]) => r).flatMap(([r, f, m]) => (r.includes('\\') ? [[r.replace(/\\/g, '\\\\'), f, m], [r.replace(/\\/g, '/'), f, m], [r, f, m]] : [[r, f, m]]));
  return {
    salt: raw.salt,
    keep: (raw.keepGuids || []).map((g) => g.toLowerCase()),
    literalsSorted: literals.sort((a, b) => b[0].length - a[0].length),
    leakTokens: (raw.leakTokens || []).map((t) => t.toLowerCase()),
  };
}

// Returns a restore callback so capturing a SPA never changes its live form values or rehashes a pseudonym.
async function pseudonymisePage(page, cfg) {
  const src = `((cfg) => {
    const pseudoText = ${pseudoText.toString()};
    const key = Symbol.for('ccof.docs.capture.undo');
    if (globalThis[key]) throw new Error('documentation capture already in progress');
    const undo = globalThis[key] = [];
    const property = (e, name) => {
      const original = e[name], value = pseudoText(original, cfg);
      if (value === original) return;
      undo.push(() => { if (e[name] === value) e[name] = original; });
      e[name] = value;
    };
    try {
      const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) property(n, 'nodeValue');
      for (const i of document.querySelectorAll('input, textarea')) property(i, 'value');
      for (const e of document.querySelectorAll('[title],[aria-label]')) {
        if (e.title) property(e, 'title');
        const original = e.getAttribute('aria-label'), value = pseudoText(original, cfg);
        if (value !== original) {
          undo.push(() => { if (e.getAttribute('aria-label') === value) e.setAttribute('aria-label', original); });
          e.setAttribute('aria-label', value);
        }
      }
    } catch (error) {
      for (const restore of undo.reverse()) restore();
      delete globalThis[key];
      throw error;
    }
  })(${JSON.stringify(cfg)})`;
  const prepared = [];
  const restore = async () => {
    for (const frame of prepared) await frame.evaluate(() => {
      const key = Symbol.for('ccof.docs.capture.undo');
      for (const undo of (globalThis[key] ?? []).reverse()) undo();
      delete globalThis[key];
    });
  };
  try {
    for (const frame of page.frames()) { await frame.evaluate(src); prepared.push(frame); }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

// Every real value the mapping names, and every leak token (for example a username), found in a text: a leak
// check for captures. A capture with any is not used.
function leaks(text, cfg) {
  const lower = String(text).toLowerCase();
  const literal = cfg.literalsSorted.filter(([r, , m]) => (m === 'word' ? new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(String(text)) : lower.includes(r.toLowerCase()))).map(([r]) => r);
  const tokens = (cfg.leakTokens || []).filter((t) => lower.includes(t));
  return [...literal, ...tokens];
}

async function capturePseudonymised(page, cfg, options) {
  const restore = await pseudonymisePage(page, cfg);
  try {
    for (const frame of page.frames()) {
      const shown = await frame.evaluate(() => [
        document.body?.innerText ?? "",
        ...Array.from(document.querySelectorAll('input, textarea'), (e) => e.value),
        ...Array.from(document.querySelectorAll('[title],[aria-label]'), (e) => `${e.title} ${e.getAttribute('aria-label') ?? ''}`),
      ].join('\n'));
      const remaining = leaks(shown, cfg);
      if (remaining.length) throw new Error(`real values remain: ${remaining.length}; screenshot not written`);
    }
    await page.screenshot(options);
  } finally {
    await restore();
  }
}

module.exports = { pseudoText, loadConfig, pseudonymisePage, capturePseudonymised, leaks };

// CLI: node pseudonymise.cjs <mapping.json> <in.txt> <out.txt> — the same replacement for terminal logs.
if (require.main === module) {
  const [map, input, output] = process.argv.slice(2);
  const fs = require('fs');
  const cfg = loadConfig(map);
  const text = pseudoText(fs.readFileSync(input, 'utf8'), cfg);
  const left = leaks(text, cfg);
  if (left.length) { console.error(`real values remain: ${left.length}`); process.exit(1); }
  fs.writeFileSync(output, text);
}
