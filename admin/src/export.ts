// Export for Power BI and spreadsheets (ADR-0034, ROADMAP G7b). Two datasets that join on the group ID:
// - export/usage: one row per chargeback ID, group (projectLabel) and person for a period, priced at the
//   rate card (list price, not an invoice), with the chargeback filters of the console;
// - export/groups: each onboarded group's configuration: budget, cap, surfaces, expected cache share.
// Formats: json (default; for Power BI's Web connector) or csv. Values that a spreadsheet would read as a
// formula are prefixed with an apostrophe (OWASP "CSV Injection").

import { ApiError } from "./auth.ts";
import { neutraliseFormula } from "./text-rules.ts";
import type { ApiResponse } from "./api.ts";
import { buildChargebackQuery, prepareRateCard, readChargebackFilters, readChargebackSettings, shapeRows, tableRows } from "./chargeback.ts";
import type { Configured } from "./chargeback.ts";
import type { Capability } from "./operations.ts";
import { ProviderError } from "./operations.ts";
import { isObject } from "./validation.ts";
import type { Doc } from "./validation.ts";
import type { V3Dependencies } from "./v3.ts";
import type { GroupMetadata } from "../../analytics/workbooks/chargeback-queries.ts";
import { DEFAULT_USER_TAG_LABEL, userTagHeaders } from "../../src/contracts/user-tags.ts";
import { historyBoundary, historyCoverage, historyRows, mergeUsageRows, readHistoryDocs, readHistorySettings, splitRange } from "./history.ts";
import type { HistoryStore, Range } from "./history.ts";

export const EXPORT_ROWS_MAX = 5000;
const FORMATS = ["json", "csv"];
const GROUP_COLUMNS = [
  "groupId", "displayName", "status", "chargebackId", "priority", "budgetMode", "perUserAmount", "perUserCurrency",
  "groupCapAmount", "groupCapCurrency", "surfaces", "expectedCacheReadPercent", "cacheBasis", "restrictedFamiliesApproved",
];

export interface ExportHelpers {
  capability(deps: V3Dependencies, cfg: Configured<unknown>, name: string, run: () => Promise<unknown>): Promise<Capability>;
  currentRateCard(deps: V3Dependencies): Promise<{ rateCard: Doc; source: string } | null>;
  groupMetadata(deps: V3Dependencies, projectId: string): Promise<GroupMetadata[]>;
  // The request ID the handler logs; every error body carries it, as V3 errors do.
  requestId: string;
}

const refusal = (status: number, body: Doc, requestId: string): ApiResponse =>
  ({ status, headers: { "cache-control": "no-store", "content-type": "application/json" }, jsonBody: { ...body, requestId } });

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${neutraliseFormula(text).replace(/"/g, '""')}"`;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ADR-0044: with ADMIN_CHARGEBACK_HISTORY_CONTAINER, the part of the range before the Log Analytics window is read from
// chargeback history; without it, the whole range stays on Log Analytics.
function historySplit(period: Range, backend: string, deps: V3Dependencies): { history: Range | null; logs: Range | null } {
  const settings = readHistorySettings(deps.env);
  if (settings === null) return { history: null, logs: period };
  if (settings === "invalid") throw new ApiError(503, "chargeback_history_settings_invalid");
  const split = splitRange(period, historyBoundary(deps.now(), settings.retentionDays, settings.retentionHeldFrom));
  if (split.history && backend) throw new ApiError(400, "backend_filter_not_in_history");
  if (split.history && !deps.chargebackHistory) throw new ApiError(503, "chargeback_history_not_configured");
  return split;
}

function groupRow(doc: Doc): Doc {
  const budget = isObject(doc.budget) ? doc.budget : {};
  const perUser = isObject(budget.perUser) ? budget.perUser : {};
  const cap = isObject(budget.groupCap) ? budget.groupCap : null;
  const cache = isObject(doc.cacheProfile) ? doc.cacheProfile : {};
  return {
    groupId: doc.groupId, displayName: doc.displayName, status: doc.status, chargebackId: doc.chargebackId ?? null, priority: doc.priority,
    budgetMode: budget.mode ?? null, perUserAmount: perUser.amount ?? null, perUserCurrency: perUser.currency ?? null,
    groupCapAmount: cap?.amount ?? null, groupCapCurrency: cap?.currency ?? null,
    surfaces: Array.isArray(doc.surfaces) ? doc.surfaces.join(";") : null,
    expectedCacheReadPercent: cache.expectedCacheReadPercent ?? null, cacheBasis: cache.basis ?? null,
    restrictedFamiliesApproved: doc.restrictedFamiliesApproved ?? null,
  };
}

function respond(format: string, columns: string[], rows: Doc[], meta: Doc, extra: Record<string, string> = {}, label?: string): ApiResponse {
  const headers = { "cache-control": "no-store", ...extra };
  if (format === "csv") {
    return { status: 200, headers: { ...headers, "content-type": "text/csv; charset=utf-8" }, body: toCsv(label === undefined ? columns : userTagHeaders(columns, label), rows.map((r) => columns.map((c) => r[c]))) };
  }
  return { status: 200, headers: { ...headers, "content-type": "application/json" }, jsonBody: { ...meta, columns, rows } };
}

export async function handleExport(kind: string, params: URLSearchParams, deps: V3Dependencies, helpers: ExportHelpers): Promise<ApiResponse> {
  const format = params.get("format") ?? "json";
  if (!FORMATS.includes(format)) throw new ApiError(400, "invalid_format");
  const rest = new URLSearchParams([...params].filter(([k]) => k !== "format"));
  if (kind === "groups") {
    if ([...rest.keys()].length) throw new ApiError(400, "unknown_parameter");
    if (!deps.projects) throw new ApiError(503, "project_store_not_configured");
    const docs = (await deps.projects.list()).map((p) => p.doc).filter((d) => d.kind === "group");
    const rows = docs.map(groupRow).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    return respond(format, GROUP_COLUMNS, rows, { dataset: "groups", observedAt: deps.now().toISOString() });
  }
  if (kind !== "usage") throw new ApiError(404, "export_not_found");
  // Only filters the export applies are accepted: tags, paging and the trend interval are refused
  // rather than ignored, so a file is never silently broader than its request.
  const allowed = ["period", "from", "to", "project", "group", "developer", "model", "backend", "family", "classification", "chargeback"];
  if ([...rest.keys()].some((k) => !allowed.includes(k))) throw new ApiError(400, "unknown_parameter");
  const cfg = readChargebackSettings(deps.env);
  const filters = { ...readChargebackFilters(rest, deps.now(), cfg.ok ? cfg.value.maxQueryDays : 62), offset: 0, limit: EXPORT_ROWS_MAX };
  const split = historySplit(filters.period, filters.backend, deps);
  // ADR-0044 decision 8: a day history never covered is refused, never exported as zero usage.
  const coverage = split.history ? await historyCoverage(deps.chargebackHistory as HistoryStore, split.history, deps.now()) : null;
  // ADR-0044 decision 9: a day whose documents may have expired is refused, never exported with what is left.
  if (coverage && coverage.expired.length) {
    return refusal(409, { error: "history_expired", expiredDays: coverage.expired, expiresAt: coverage.expiresAt }, helpers.requestId);
  }
  if (coverage && coverage.uncovered.length) {
    return refusal(409, { error: "history_not_covered", uncoveredDays: coverage.uncovered }, helpers.requestId);
  }
  const result = await helpers.capability(deps, cfg, "chargeback", async () => {
    const card = await helpers.currentRateCard(deps);
    if (!card || !cfg.ok || !deps.sources || !deps.operations.query) throw new ProviderError(503, "rate_card_unavailable");
    const prepared = prepareRateCard(card.rateCard);
    const groups = await helpers.groupMetadata(deps, filters.project);
    let logs: { columns: string[]; rows: Doc[]; truncated: boolean } | null = null;
    if (split.logs) {
      const logFilters = split.history ? { ...filters, period: { mode: "custom" as const, ...split.logs } } : filters;
      const query = buildChargebackQuery("chargebackUsage", logFilters, cfg.value, deps.sources, prepared, groups);
      const table = await deps.operations.query(cfg.value.workspaceId, query, `${logFilters.period.from}/${logFilters.period.to}`, { kind: "chargeback", view: "chargebackUsage", filters: logFilters as unknown as Doc });
      const shaped = shapeRows(tableRows(table));
      const hidden = ["reportRows", "displayedLimit", "truncated", "pageOffset", "reportRowNumber", "rateCardSha256", "ledgerSha256"];
      logs = { columns: table.columns.map((c) => c.name).filter((c) => !hidden.includes(c)), rows: shaped.rows, truncated: shaped.truncated };
    }
    if (!split.history) return { ...(logs as NonNullable<typeof logs>), rateCardVersion: prepared.version };
    const docs = await readHistoryDocs(deps.chargebackHistory as HistoryStore, split.history);
    const merged = mergeUsageRows(logs?.rows ?? [], logs?.columns ?? null, historyRows(docs, filters, groups, filters.period), filters.period);
    const sources = [{ source: "chargebackHistory", ...split.history, openDays: coverage?.open ?? [] }, ...(split.logs ? [{ source: "logAnalytics", ...split.logs }] : [])];
    return { columns: merged.columns, rows: merged.rows.slice(0, EXPORT_ROWS_MAX), truncated: (logs?.truncated ?? false) || merged.rows.length > EXPORT_ROWS_MAX, rateCardVersion: prepared.version, sources };
  });
  // Only an available or partial (truncated) capability carries data.
  if (!isObject(result.data)) {
    return refusal(503, { error: "export_unavailable", capability: result }, helpers.requestId);
  }
  const data = result.data;
  let label: string | undefined;
  if (format === "csv") {
    if (!deps.userTagStore) throw new ApiError(503, "user_tags_not_configured");
    try { label = (await deps.userTagStore.readSettings())?.label ?? DEFAULT_USER_TAG_LABEL; }
    catch { throw new ApiError(500, "user_tag_settings_unavailable"); }
  }
  const truncated = data.truncated === true;
  return respond(format, data.columns as string[], data.rows as Doc[], {
    dataset: "usage", period: filters.period, truncated, rowLimit: EXPORT_ROWS_MAX, rateCardVersion: data.rateCardVersion,
    ...(data.sources ? { sources: data.sources } : {}),
    basis: "List price at the approved rate card (100 CCU = USD 1); not an Azure invoice.",
    filters: { project: filters.project, group: filters.group, developer: filters.developer, model: filters.model, backend: filters.backend,
      family: filters.family, classification: filters.classification, chargeback: filters.chargeback },
  }, {
    "x-ccof-truncated": String(truncated), "x-ccof-row-limit": String(EXPORT_ROWS_MAX),
    // The CSV has no sources: covered history days not yet closed, comma-separated (empty: none).
    ...(coverage ? { "x-ccof-history-open-days": coverage.open.join(",") } : {}),
  }, label);
}
