// ADR-0046: the deployment's backends and model deployments reach the admin app as ADMIN_BACKENDS, written by
// Stage 5 from the configuration's backends (id and deploymentInferenceGeo keys, the deployment names).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBackendSettings } from "../src/backend-settings.ts";

test("ADMIN_BACKENDS is parsed strictly: sorted, de-duplicated, and anything malformed is invalid (ADMIN-1)", () => {
  const ok = readBackendSettings({ ADMIN_BACKENDS: '[{"id":"b2","deployments":["m-2","m-1","m-2"]},{"id":"b1","deployments":[]}]' });
  assert.deepEqual(ok, { state: "configured", backends: [{ id: "b1", deployments: [] }, { id: "b2", deployments: ["m-1", "m-2"] }] });
  assert.equal(readBackendSettings({ ADMIN_BACKENDS: " " }).state, "not_configured");
  for (const bad of ["[]", "{}", '[{"id":"b1"}]', '[{"id":"b1","deployments":["bad name"]}]', '[{"id":"b1","deployments":[]},{"id":"b1","deployments":[]}]']) {
    assert.equal(readBackendSettings({ ADMIN_BACKENDS: bad }).state, "invalid", bad);
  }
});

test("Stage 5 writes ADMIN_BACKENDS from each backend's id and deployment names (ADMIN-1)", async () => {
  const stage5 = await readFile(new URL("../../infra/staged/stage5-config.bicep", import.meta.url), "utf8");
  assert.match(stage5, /ADMIN_BACKENDS: string\(map\(backends, b => \{ id: b\.id, deployments: b\.\?deployments \?\? \[\] \}\)\)/);
  const application = await readFile(new URL("../../infra/staged/Staged.Application.ps1", import.meta.url), "utf8");
  assert.match(application, /backends = @\(Get-StgApimBackendPlan \$Cfg\)/);
  const helper = fileURLToPath(new URL("../../infra/staged/Staged.FoundryFailover.ps1", import.meta.url)).replaceAll("'", "''");
  const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; . '${helper}'; $cfg=@{backends=@(@{id='logical';url='https://primary';deploymentInferenceGeo=@{'m-2'='global';'m-1'='global'};failover=@{url='https://standby'}})}; @(Get-StgApimBackendPlan $cfg) | ConvertTo-Json -AsArray -Depth 20`
  ], { encoding: "utf8" });
  const plan = JSON.parse(output);
  assert.equal(plan[0].failover.id, "logical-failover");
  assert.deepEqual(readBackendSettings({ ADMIN_BACKENDS: JSON.stringify(plan.map(({ id, deployments }: { id: string; deployments: string[] }) => ({ id, deployments }))) }),
    { state: "configured", backends: [{ id: "logical", deployments: ["m-1", "m-2"] }] });
});
