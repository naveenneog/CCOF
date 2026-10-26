// Reconciler settings (ADR-0018 decision 9): every interval, validity, timeout
// and limit is an app setting without a default; a missing or invalid one is
// named, with a problem code and never its value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTING_NAMES, readReconcilerSettings } from "../src/reconciler/settings.ts";
import { validSettings } from "./helpers/reconciler-fixtures.ts";

test("a complete, valid set of settings is read with every value typed", () => {
  const result = readReconcilerSettings(validSettings());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.settings, {
    managedIdentityClientId: "00000000-0000-4000-8000-000000000100",
    intervalMinutes: 2,
    validitySeconds: 600,
    leaseSeconds: 300,
    workspaceId: "00000000-0000-4000-8000-000001100000",
    logAnalyticsEndpoint: "https://api.loganalytics.io",
    gatewayResourceId: "/subscriptions/00000000-0000-4000-8000-000000000110/resourceGroups/sample-pilot-rg/providers/Microsoft.ApiManagement/service/sample-pilot-apim",
    ledgerTimeoutSeconds: 60,
    ledgerMaxRows: 100000,
    maxStates: 10000,
    writeConcurrency: 8,
    cosmosEndpoint: "https://sample-pilot-cosmos.documents.azure.com:443/",
    cosmosDatabase: "ccof",
    containers: {
      projects: "projects",
      entitlement: "entitlement",
      budgetState: "budgetState",
      aggregateState: "aggregateBudgetState",
      lease: "reconcilerLease",
    },
  });
});

test("every setting is required: removing any one names exactly that setting as missing", () => {
  for (const name of SETTING_NAMES) {
    const settings = validSettings();
    delete settings[name];
    const result = readReconcilerSettings(settings);
    assert.equal(result.ok, false, name);
    if (result.ok) continue;
    assert.deepEqual(result.problems, [{ setting: name, problem: "missing" }], name);
  }
});

test("a blank value is missing, not a default", () => {
  const result = readReconcilerSettings(validSettings({ RECONCILER_VALIDITY_SECONDS: "   " }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problems, [{ setting: "RECONCILER_VALIDITY_SECONDS", problem: "missing" }]);
});

test("the schedule must be an every-N-minutes NCRONTAB, N from 1 to 59", () => {
  for (const schedule of ["0 */2 * * *", "*/2 * * * * *", "0 */0 * * * *", "0 */60 * * * *", "0 2 * * * *", "0 */2 * * * * *", "00:02:00"]) {
    const result = readReconcilerSettings(validSettings({ RECONCILER_SCHEDULE: schedule }));
    assert.equal(result.ok, false, schedule);
    if (!result.ok) assert.deepEqual(result.problems, [{ setting: "RECONCILER_SCHEDULE", problem: "invalid" }], schedule);
  }
  for (const [schedule, minutes] of [["0 */1 * * * *", 1], ["0 */59 * * * *", 59]] as const) {
    const result = readReconcilerSettings(validSettings({ RECONCILER_SCHEDULE: schedule, RECONCILER_VALIDITY_SECONDS: "7200" }));
    assert.equal(result.ok && result.settings.intervalMinutes, minutes, schedule);
  }
});

test("validity must exceed the interval plus the ledger timeout, so state cannot lapse between healthy runs", () => {
  // interval 2 min = 120 s, ledger timeout 60 s: 180 is not enough, 181 is.
  const atBound = readReconcilerSettings(validSettings({ RECONCILER_VALIDITY_SECONDS: "180" }));
  assert.equal(atBound.ok, false);
  if (!atBound.ok) assert.deepEqual(atBound.problems, [{ setting: "RECONCILER_VALIDITY_SECONDS", problem: "not_above_interval_plus_ledger_timeout" }]);
  assert.equal(readReconcilerSettings(validSettings({ RECONCILER_VALIDITY_SECONDS: "181" })).ok, true);
});

test("the lease must last at least twice the ledger timeout, so one slow query cannot lose it mid-run", () => {
  const short = readReconcilerSettings(validSettings({ RECONCILER_LEASE_SECONDS: "119" }));
  assert.equal(short.ok, false);
  if (!short.ok) assert.deepEqual(short.problems, [{ setting: "RECONCILER_LEASE_SECONDS", problem: "shorter_than_twice_ledger_timeout" }]);
  assert.equal(readReconcilerSettings(validSettings({ RECONCILER_LEASE_SECONDS: "120" })).ok, true);
});

test("numbers outside their documented or sanity range are refused, as are non-integers", () => {
  const cases: Array<[string, string, string]> = [
    ["RECONCILER_LEDGER_TIMEOUT_SECONDS", "601", "out_of_range"],
    ["RECONCILER_LEDGER_TIMEOUT_SECONDS", "0", "out_of_range"],
    ["RECONCILER_LEDGER_MAX_ROWS", "500001", "out_of_range"],
    ["RECONCILER_LEDGER_MAX_ROWS", "0", "out_of_range"],
    ["RECONCILER_MAX_STATES", "0", "out_of_range"],
    ["RECONCILER_WRITE_CONCURRENCY", "33", "out_of_range"],
    ["RECONCILER_WRITE_CONCURRENCY", "0", "out_of_range"],
    ["RECONCILER_VALIDITY_SECONDS", "86401", "out_of_range"],
    ["RECONCILER_VALIDITY_SECONDS", "600.5", "invalid"],
    ["RECONCILER_VALIDITY_SECONDS", "-600", "invalid"],
    ["RECONCILER_LEASE_SECONDS", "1e3", "invalid"],
  ];
  for (const [name, value, problem] of cases) {
    const result = readReconcilerSettings(validSettings({ [name]: value }));
    assert.equal(result.ok, false, `${name}=${value}`);
    if (!result.ok) assert.ok(result.problems.some((p) => p.setting === name && p.problem === problem), `${name}=${value}: ${JSON.stringify(result.problems)}`);
  }
});

test("identifiers are validated: GUIDs, the APIM resource id, the Cosmos endpoint and names", () => {
  const cases: Array<[string, string]> = [
    ["RECONCILER_MANAGED_IDENTITY_CLIENT_ID", "not-a-guid"],
    ["RECONCILER_LOG_ANALYTICS_WORKSPACE_ID", "sample-pilot-law"],
    ["RECONCILER_LOG_ANALYTICS_ENDPOINT", "http://api.loganalytics.io"],
    ["RECONCILER_LOG_ANALYTICS_ENDPOINT", "https://api.loganalytics.io/v1/workspaces"],
    ["RECONCILER_LOG_ANALYTICS_ENDPOINT", "https://user:@api.loganalytics.io"],
    ["RECONCILER_LEDGER_GATEWAY_RESOURCE_ID", "/subscriptions/00000000-0000-4000-8000-000000000110/resourceGroups/sample-pilot-rg/providers/Microsoft.Web/sites/x"],
    ["RECONCILER_LEDGER_GATEWAY_RESOURCE_ID", "/subscriptions/00000000-0000-4000-8000-000000000110/resourceGroups/rg'|take 1/providers/Microsoft.ApiManagement/service/apim"],
    ["COSMOS_ENDPOINT", "http://sample-pilot-cosmos.documents.azure.com/"],
    ["COSMOS_ENDPOINT", "https://evil.example.com/"],
    ["COSMOS_DATABASE", "-bad"],
    ["RECONCILER_LEASE_CONTAINER", "has space"],
  ];
  for (const [name, value] of cases) {
    const result = readReconcilerSettings(validSettings({ [name]: value }));
    assert.equal(result.ok, false, `${name}=${value}`);
    if (!result.ok) assert.deepEqual(result.problems, [{ setting: name, problem: "invalid" }], `${name}=${value}`);
  }
});

test("the reconciler never writes into a container it reads or another writer's container", () => {
  const writesProjects = readReconcilerSettings(validSettings({ RECONCILER_BUDGET_STATE_CONTAINER: "projects" }));
  assert.equal(writesProjects.ok, false);
  if (!writesProjects.ok) assert.deepEqual(writesProjects.problems, [{ setting: "RECONCILER_BUDGET_STATE_CONTAINER", problem: "same_as_other_container" }]);
  const leaseInState = readReconcilerSettings(validSettings({ RECONCILER_LEASE_CONTAINER: "aggregateBudgetState" }));
  assert.equal(leaseInState.ok, false);
  if (!leaseInState.ok) assert.deepEqual(leaseInState.problems, [{ setting: "RECONCILER_LEASE_CONTAINER", problem: "same_as_other_container" }]);
});

test("problems carry setting names and codes only, never the offending value", () => {
  const secretish = "Bearer abc.def.ghi";
  const result = readReconcilerSettings(validSettings({ RECONCILER_LOG_ANALYTICS_WORKSPACE_ID: secretish }));
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secretish), false);
});

// ADR-0040: the budget guard is optional, all three settings or none; each is a whole number in range.
const GUARD = { RECONCILER_BUDGET_WARN_PERCENT: "80", RECONCILER_OVERSHOOT_PERCENT: "5", RECONCILER_PROJECTION_MINUTES: "5" };
test("without the budget guard settings there is no guard; with all three it is read", () => {
  const without = readReconcilerSettings(validSettings());
  assert.equal(without.ok && without.settings.guard, undefined);
  const withGuard = readReconcilerSettings({ ...validSettings(), ...GUARD });
  assert.deepEqual(withGuard.ok && withGuard.settings.guard, { warnPercent: 80, overshootPercent: 5, projectionMinutes: 5 });
});

test("a partial or out-of-range budget guard is refused, naming the setting", () => {
  const { RECONCILER_OVERSHOOT_PERCENT: _dropped, ...partial } = GUARD;
  const missing = readReconcilerSettings({ ...validSettings(), ...partial });
  assert.deepEqual(!missing.ok && missing.problems, [{ setting: "RECONCILER_OVERSHOOT_PERCENT", problem: "missing" }]);
  for (const [name, value] of [["RECONCILER_BUDGET_WARN_PERCENT", "0"], ["RECONCILER_BUDGET_WARN_PERCENT", "100"], ["RECONCILER_OVERSHOOT_PERCENT", "0"], ["RECONCILER_OVERSHOOT_PERCENT", "51"], ["RECONCILER_PROJECTION_MINUTES", "0"], ["RECONCILER_PROJECTION_MINUTES", "61"], ["RECONCILER_PROJECTION_MINUTES", "5.5"]] as const) {
    const result = readReconcilerSettings({ ...validSettings(), ...GUARD, [name]: value });
    assert.equal(result.ok, false, `${name}=${value}`);
    assert.equal(!result.ok && result.problems[0].setting, name);
  }
});
// ADR-0044: chargeback history is optional, the container and the closing delay together or neither.
const HISTORY = { RECONCILER_HISTORY_CONTAINER: "chargebackDaily", RECONCILER_HISTORY_CLOSE_AFTER_DAYS: "2" };
test("without the history settings there is no history; with both it is read", () => {
  const without = readReconcilerSettings(validSettings());
  assert.ok(without.ok && without.settings.history === undefined);
  const withHistory = readReconcilerSettings(validSettings(HISTORY));
  assert.ok(withHistory.ok);
  if (withHistory.ok) assert.deepEqual(withHistory.settings.history, { container: "chargebackDaily", closeAfterDays: 2, ttlDays: null });
  const withTtl = readReconcilerSettings(validSettings({ ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "400" }));
  assert.ok(withTtl.ok && withTtl.settings.history?.ttlDays === 400);
});

test("the history time to live is optional, 1-24855 whole days, and only with the history settings", () => {
  const problems = (overrides: Record<string, string>) => {
    const result = readReconcilerSettings(validSettings(overrides));
    return result.ok ? [] : result.problems;
  };
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "24855" }), []);
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "0" }), [{ setting: "RECONCILER_HISTORY_TTL_DAYS", problem: "out_of_range" }]);
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "24856" }), [{ setting: "RECONCILER_HISTORY_TTL_DAYS", problem: "out_of_range" }]);
  assert.deepEqual(problems({ RECONCILER_HISTORY_TTL_DAYS: "400" }).map((p) => p.setting).sort(), ["RECONCILER_HISTORY_CLOSE_AFTER_DAYS", "RECONCILER_HISTORY_CONTAINER"]);
});

test("history settings are refused half-set, out of range, or naming another reconciler container", () => {
  const problems = (overrides: Record<string, string>) => {
    const result = readReconcilerSettings(validSettings(overrides));
    return result.ok ? [] : result.problems;
  };
  assert.deepEqual(problems({ RECONCILER_HISTORY_CONTAINER: "chargebackDaily" }), [{ setting: "RECONCILER_HISTORY_CLOSE_AFTER_DAYS", problem: "missing" }]);
  assert.deepEqual(problems({ RECONCILER_HISTORY_CLOSE_AFTER_DAYS: "2" }), [{ setting: "RECONCILER_HISTORY_CONTAINER", problem: "missing" }]);
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_CLOSE_AFTER_DAYS: "0" }), [{ setting: "RECONCILER_HISTORY_CLOSE_AFTER_DAYS", problem: "out_of_range" }]);
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_CLOSE_AFTER_DAYS: "8" }), [{ setting: "RECONCILER_HISTORY_CLOSE_AFTER_DAYS", problem: "out_of_range" }]);
  assert.deepEqual(problems({ ...HISTORY, RECONCILER_HISTORY_CONTAINER: "budgetState" }), [{ setting: "RECONCILER_HISTORY_CONTAINER", problem: "same_as_other_container" }]);
});
