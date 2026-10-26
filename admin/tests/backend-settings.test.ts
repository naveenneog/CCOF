// ADR-0046: the deployment's backends and model deployments reach the admin app as ADMIN_BACKENDS, written by
// Stage 5 from the configuration's backends (id and deploymentInferenceGeo keys, the deployment names).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(application, /backends = @\(\$Cfg\.backends \| ForEach-Object \{ @\{ id = \$_\.id; url = \$_\.url; deployments = @\(if \(\$_\.deploymentInferenceGeo\) \{ \$_\.deploymentInferenceGeo\.Keys \| Sort-Object \}\) \} \}\)/);
});
