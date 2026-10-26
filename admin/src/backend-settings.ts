// The deployment's Foundry backends and their model deployments (ADR-0046), from the ADMIN_BACKENDS app setting
// that Stage 5 writes from the configuration's `backends[].id` and `backends[].deploymentInferenceGeo` keys:
// [{"id":"<backendId>","deployments":["<deployment>", ...]}]. A group may route only to one of these backends
// and admit only models deployed on it; the gateway refuses an unknown backend (`backend_not_configured`) and
// Foundry an unknown deployment, so the admin refuses both before saving.

import { ApiError } from "./auth.ts";
import { isIdentifier, isObject } from "./validation.ts";
import type { Doc } from "./validation.ts";

export interface BackendDeployments { id: string; deployments: string[] }
export type BackendSettings =
  | { state: "configured"; backends: BackendDeployments[] }
  | { state: "not_configured" | "invalid"; backends: [] };

// The deployment-name pattern of the configuration schema (config/core.answers.schema.json).
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function readBackendSettings(env: Readonly<Record<string, string | undefined>>): BackendSettings {
  const raw = env.ADMIN_BACKENDS?.trim();
  if (!raw) return { state: "not_configured", backends: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { state: "invalid", backends: [] }; }
  if (!Array.isArray(value) || value.length === 0) return { state: "invalid", backends: [] };
  const backends: BackendDeployments[] = [];
  for (const item of value) {
    if (!isObject(item) || !isIdentifier(item.id) || !Array.isArray(item.deployments) ||
      !item.deployments.every((d) => typeof d === "string" && DEPLOYMENT.test(d))) return { state: "invalid", backends: [] };
    backends.push({ id: item.id, deployments: [...new Set(item.deployments as string[])].sort() });
  }
  if (new Set(backends.map((b) => b.id)).size !== backends.length) return { state: "invalid", backends: [] };
  return { state: "configured", backends: backends.sort((a, b) => a.id.localeCompare(b.id)) };
}

function modelsByFamily(doc: Doc | null): [string, string[]][] {
  const policy = doc && isObject(doc.familyPolicy) ? doc.familyPolicy : {};
  const families = isObject(policy.families) ? policy.families : {};
  return Object.entries(families).map(([family, entry]) => [family, isObject(entry) && Array.isArray(entry.models) ? entry.models.map(String) : []]);
}

export class BackendNotDeployed extends ApiError {
  readonly problems: string[];
  readonly allowed: { backendIds: string[]; deployments: string[] };
  constructor(problems: string[], allowed: { backendIds: string[]; deployments: string[] }) {
    super(422, "invalid_group");
    this.problems = problems;
    this.allowed = allowed;
  }
}

// Checks what this write introduces: a new or changed backend, and models not already admitted on the same
// backend. A model stored earlier (or removed from the deployment since) never blocks an unrelated edit.
export function assertDeployed(after: Doc, before: Doc | null, settings: BackendSettings): void {
  const backendChanged = before === null || before.backendId !== after.backendId;
  const known = new Set(backendChanged ? [] : modelsByFamily(before).flatMap(([, models]) => models));
  const added = modelsByFamily(after).map(([family, models]) => [family, models.filter((m) => !known.has(m))] as const).filter(([, models]) => models.length > 0);
  if (!backendChanged && added.length === 0) return;
  if (settings.state !== "configured") throw new ApiError(503, settings.state === "invalid" ? "backend_list_invalid" : "backend_list_not_configured");
  const backend = settings.backends.find((b) => b.id === after.backendId);
  const backendIds = settings.backends.map((b) => b.id);
  if (!backend) throw new BackendNotDeployed(["backendId:not_deployed"], { backendIds, deployments: [] });
  const problems = added.filter(([, models]) => models.some((m) => !backend.deployments.includes(m))).map(([family]) => `familyPolicy.families.${family}.models:not_deployed`);
  if (problems.length > 0) throw new BackendNotDeployed(problems, { backendIds, deployments: backend.deployments });
}
