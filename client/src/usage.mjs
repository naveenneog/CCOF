// The /usage skill's script (docs/USAGE.md): the caller's own CCOF budget from the gateway's
// GET /ccof/me/usage, with the token the existing helper issues (src/token-service.mjs). Prints plain lines
// for Claude Code to show. --statusline prints one short line for a Claude Code status line and caches it
// for 60 seconds next to the client configuration (the line and its time only, never a token).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClientError } from './errors.mjs';

export const STATUSLINE_CACHE_FILE = 'usage-statusline.json';
export const STATUSLINE_CACHE_MS = 60_000;
const USAGE_TEXT = 'Usage: ccof-usage [--statusline]';
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export class UsageError extends Error {}

// "$1,234.57": exact half-up rounding from the gateway's decimal string, no floating point; `decimals` digits
// after the point (2, or 4 for a budget under $1).
export function formatAmount(value, decimals = 2) {
  const match = DECIMAL.exec(String(value));
  if (!match) return '$?';
  const scale = 10n ** BigInt(decimals);
  const fraction = (match[2] ?? '').padEnd(decimals + 1, '0');
  let units = BigInt(match[1]) * scale + BigInt(fraction.slice(0, decimals) || '0');
  if (Number(fraction[decimals]) >= 5) units += 1n;
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${(units % scale).toString().padStart(decimals, '0')}`;
}

// Cents hide what is left of a budget under $1 (bug bash DEV-13); such a budget's figures get four decimals.
const decimalsFor = (budgetUsd) => {
  const match = DECIMAL.exec(String(budgetUsd));
  return match && match[1].replace(/^0+/, '') === '' ? 4 : 2;
};

const percentText = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.floor(value)}%` : '');

function asOfText(asOf, now) {
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return '';
  const iso = at.toISOString();
  const time = iso.slice(11, 16);
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? `${time} UTC` : `${iso.slice(0, 10)} ${time} UTC`;
}

// Only identifiers reach the output, which Claude Code puts in the model's context: no directory display
// name, and nothing outside the scope-ID pattern (a GUID for a group, an identifier for a project).
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const safeId = (value) => (typeof value === 'string' && ID.test(value) ? value : '(unnamed)');

function label(scope) {
  return scope.classification === 'group'
    ? `group ${safeId(scope.projectId)}`
    : `project ${safeId(scope.projectId)} / ${safeId(scope.classification)}`;
}

function scopeLine(scope, period, now) {
  const head = `CCOF budget, ${label(scope)}`;
  if (scope.status === 'not_computed') return `${head}: no figures for ${period} yet.`;
  if (scope.status !== 'current' || !scope.spent || !scope.budget || !scope.remaining) return `${head}: figures unavailable; ask your platform team.`;
  const pct = percentText(scope.percentUsed);
  const d = decimalsFor(scope.budget.usd);
  let line = `${head}: ${formatAmount(scope.spent.usd, d)} of ${formatAmount(scope.budget.usd, d)} used${pct ? ` (${pct})` : ''}, `
    + `${formatAmount(scope.remaining.usd, d)} left, as of ${asOfText(scope.asOf, now)}.`;
  if (scope.exhausted) line += ' Budget used up: new requests are refused until next month.';
  else if (scope.warning === true && Number(scope.projectedPercent) >= 100) line += ' Projected spend has reached this budget: new requests are refused until recorded spend catches up or the budget is raised.';
  else if (scope.warning === true) line += ` Warning: about ${percentText(scope.projectedPercent) ?? 'most'} of this budget is used or in progress; requests are now slowed so the budget is not exceeded.`;
  if (scope.completeness === 'partial') line += ' Some requests in this period are only partly priced (for example the prompt-cache tokens of streamed replies), so actual spend is higher.';
  return line;
}

function groupLine(group) {
  if (!group) return '  Group remaining: unavailable.';
  if (!group.remaining) return '  Group: no shared cap.';
  return `  Group remaining: ${formatAmount(group.remaining.usd)}.`;
}

export function formatUsage(usage, now = new Date()) {
  if (!usage.scopes.length) return ['No CCOF budget is assigned to you on this gateway.'];
  const lines = [];
  for (const scope of usage.scopes) {
    lines.push(scopeLine(scope, usage.period, now));
    if (Object.hasOwn(scope, 'group')) lines.push(groupLine(scope.group));
  }
  if (usage.scopes.some((s) => s.status === 'current')) lines.push('Figures are from the last cost run and are a lower bound: newer requests, and the prompt-cache tokens of streamed replies, are not included.');
  if (usage.truncated) lines.push(`Only the first ${usage.scopes.length} budgets are shown.`);
  return lines;
}

// The scope with the highest spend this month: the one a request without a project selector uses.
export function statusLine(usage) {
  const current = usage.scopes.filter((s) => s.status === 'current' && s.spent && s.budget);
  if (!current.length) return '';
  const top = current.reduce((a, b) => (Number(b.spent.ccu) > Number(a.spent.ccu) ? b : a));
  const pct = percentText(top.percentUsed);
  const warn = top.exhausted ? ' - budget used up, requests refused'
    : top.warning !== true ? ''
    : Number(top.projectedPercent) >= 100 ? ' - budget reached, requests refused'
    : ` - warning: about ${percentText(top.projectedPercent) ?? 'most'} used, slowed`;
  const d = decimalsFor(top.budget.usd);
  return `CCOF ${formatAmount(top.spent.usd, d)}/${formatAmount(top.budget.usd, d)}${pct ? ` (${pct})` : ''}${warn}`;
}

export async function fetchUsage({ gatewayUrl, token, fetchImpl = fetch, timeoutMs = 15_000, signIn = 'run ccof-token login' }) {
  const url = `${String(gatewayUrl).replace(/\/+$/, '')}/ccof/me/usage`;
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (response.status === 200) {
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!body || body.schema !== 'ccof.usage.v1' || !Array.isArray(body.scopes)) throw new UsageError('The gateway sent an unexpected answer for usage.');
    return body;
  }
  const retry = response.headers.get('retry-after');
  switch (response.status) {
    case 401: throw new UsageError(`The gateway did not accept your sign-in. Sign in again: ${signIn}.`);
    case 403: throw new UsageError('This sign-in is not allowed to read usage from the gateway.');
    case 404: throw new UsageError('This gateway does not offer usage figures yet. Ask your platform team.');
    case 429: throw new UsageError(`Usage was asked for too often. Retry in ${/^\d+$/.test(retry ?? '') ? retry : 'a few'} seconds.`);
    case 503: throw new UsageError('Usage figures are temporarily unavailable. Your access to Claude is not affected. Retry shortly.');
    default: throw new UsageError(`The gateway could not return usage figures (HTTP ${response.status}).`);
  }
}

async function defaultLoad() {
  const { loadConfig } = await import('./config.mjs');
  const { config, configPath } = await loadConfig();
  const base = { gatewayUrl: config.gatewayUrl, configDir: path.dirname(configPath) };
  if (config.signInMethod === 'azure-cli') {
    const { helperToken } = await import('./helper-token.mjs');
    const helper = process.env.CCOF_TOKEN_HELPER;
    return { ...base, token: () => helperToken(helper), signIn: `run "${helper}" login` };
  }
  const { createTokenService } = await import('./token-service.mjs');
  const { createRuntime } = await import('./msal-runtime.mjs');
  const runtime = await createRuntime(config, configPath, { report: () => {} });
  const service = createTokenService(config, runtime);
  return { ...base, token: () => service.token() };
}

async function readCache(file, nowMs) {
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    return typeof cached?.at === 'number' && typeof cached?.line === 'string' && nowMs - cached.at >= 0 && nowMs - cached.at < STATUSLINE_CACHE_MS
      ? cached.line : null;
  } catch { return null; }
}

export async function runUsageCli(args, {
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
  now = () => new Date(),
  load = defaultLoad,
  fetchImpl = fetch,
} = {}) {
  const statusMode = args.length === 1 && args[0] === '--statusline';
  if (args.length > 0 && !statusMode) { stderr(`${USAGE_TEXT}\n`); return 2; }
  if (statusMode) {
    // A status line runs often and must stay quiet: any failure prints nothing.
    try {
      const { gatewayUrl, configDir, token, signIn } = await load();
      const file = path.join(configDir, STATUSLINE_CACHE_FILE);
      const nowMs = now().getTime();
      let line = await readCache(file, nowMs);
      if (line === null) {
        line = statusLine(await fetchUsage({ gatewayUrl, token: await token(), fetchImpl, signIn }));
        await writeFile(file, JSON.stringify({ at: nowMs, line }), 'utf8');
      }
      if (line) stdout(`${line}\n`);
    } catch { /* nothing on the status line */ }
    return 0;
  }
  try {
    const { gatewayUrl, token, signIn } = await load();
    const usage = await fetchUsage({ gatewayUrl, token: await token(), fetchImpl, signIn });
    stdout(`${formatUsage(usage, now()).join('\n')}\n`);
    return 0;
  } catch (error) {
    // Printed to stdout so the /usage skill shows the reason; no token is ever part of a message.
    const message = error instanceof UsageError ? error.message
      : error instanceof ClientError ? `${error.code}: ${error.message}`
        : 'Could not reach the gateway for usage figures. Check the network, then retry.';
    stdout(`${message}\n`);
    return 1;
  }
}
