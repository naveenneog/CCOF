import type { ResolveSuccess } from "../resolver/decide.ts";
import { admittedModelFamily, GROUP_SCOPE_CODE } from "../contracts/model-families.ts";
import type { DeploymentModel, ManagedClientConfig } from "./config.ts";
import { oidcSettings } from "./config.ts";

export class ClientDiscoveryRefusal extends Error {}

function offeredModels(config: ManagedClientConfig, decision: ResolveSuccess): DeploymentModel[] {
  if (decision.classification !== GROUP_SCOPE_CODE) throw new ClientDiscoveryRefusal("group_required");
  const models = config.deployments.filter((model) => model.backendId === decision.backendId
    && admittedModelFamily(decision.familyPolicy, decision.classification, model.id, decision.restrictedFamiliesApproved) !== null);
  if (models.length === 0) throw new ClientDiscoveryRefusal("no_deployed_allowed_models");
  return models;
}

export function discoveryDocument(config: ManagedClientConfig, decision: ResolveSuccess, representation: "models" | "bootstrap", now: Date): Record<string, unknown> {
  const models = offeredModels(config, decision);
  if (representation === "models") return {
    data: models.map((model) => ({ id: model.id, type: "model", display_name: model.displayName, created_at: model.createdAt })),
    has_more: false, first_id: models[0].id, last_id: models[models.length - 1].id,
  };
  // Current Desktop unifies Chat and Cowork. Do not enable the combined home when only one is admitted.
  const home = config.desktop.chat && config.desktop.cowork
    && decision.surfaces?.includes("chat") === true && decision.surfaces.includes("cowork");
  return {
    $schemaVersion: 1,
    expiresAt: Math.floor(now.getTime() / 1000) + config.refreshMinutes * 60,
    configRecheckIntervalMinutes: config.refreshMinutes,
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: config.gatewayUrl,
    inferenceGatewayAuthScheme: "bearer",
    inferenceCredentialKind: "external-idp",
    inferenceIdpAuthFlow: "browser",
    inferenceIdpOidc: { ...oidcSettings(config), bearerTokenType: "access_token", appendOfflineAccess: false },
    inferenceModels: models.map((model) => ({
      name: model.id, labelOverride: model.displayName,
      anthropicFamilyTier: admittedModelFamily(decision.familyPolicy, decision.classification, model.id, decision.restrictedFamiliesApproved),
    })),
    modelDiscoveryEnabled: false,
    inferenceCustomHeaders: { [config.projectHeaderName]: decision.projectId },
    desktopHome: home ? "standard" : "off",
    chatTabEnabled: home,
    coworkTabEnabled: home,
    isClaudeCodeForDesktopEnabled: config.desktop.code && decision.surfaces?.includes("code") === true,
  };
}
