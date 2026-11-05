// Experimental, opt-in server configuration and secret-free Windows bootstrap (ADR-0056).
export interface DeploymentModel {
  backendId: string; id: string; displayName: string; createdAt: string;
}
export interface ManagedClientConfig {
  schemaVersion: 1;
  tenantId: string;
  clientId: string;
  scope: string;
  gatewayUrl: string;
  projectHeaderName: string;
  refreshMinutes: number;
  desktop: { chat: boolean; cowork: boolean; code: boolean };
  deployments: DeploymentModel[];
}
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const BACKEND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const RESERVED_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie",
  "host", "content-type", "content-length", "connection", "transfer-encoding", "anthropic-version", "anthropic-beta"]);
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function invalid(): never { throw new Error("managed_client_config_invalid"); }

export function readManagedClientConfig(value: unknown): ManagedClientConfig {
  if (!isObject(value) || !exact(value, ["schemaVersion", "tenantId", "clientId", "scope", "gatewayUrl",
    "projectHeaderName", "refreshMinutes", "desktop", "deployments"])) invalid();
  const { schemaVersion, tenantId, clientId, scope, gatewayUrl, projectHeaderName, refreshMinutes, desktop, deployments } = value;
  if (schemaVersion !== 1 || typeof tenantId !== "string" || !GUID.test(tenantId)
    || typeof clientId !== "string" || !GUID.test(clientId) || typeof scope !== "string") invalid();
  const prefix = scope.startsWith("api://") ? "api://" : "";
  const expected = `${prefix}${clientId}/`;
  if (!scope.toLowerCase().startsWith(expected.toLowerCase()) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope.slice(expected.length))) invalid();
  if (typeof gatewayUrl !== "string" || /\s/.test(gatewayUrl)) invalid();
  let url: URL;
  try { url = new URL(gatewayUrl); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || /\/v1(?:\/messages)?\/?$/.test(url.pathname)
    || /^(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(url.hostname)) invalid();
  if (typeof projectHeaderName !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(projectHeaderName)
    || RESERVED_HEADERS.has(projectHeaderName.toLowerCase())) invalid();
  if (typeof refreshMinutes !== "number" || !Number.isInteger(refreshMinutes) || refreshMinutes < 2 || refreshMinutes > 30) invalid();
  if (!isObject(desktop) || !exact(desktop, ["chat", "cowork", "code"])
    || typeof desktop.chat !== "boolean" || typeof desktop.cowork !== "boolean" || typeof desktop.code !== "boolean") invalid();
  if (!Array.isArray(deployments) || deployments.length < 1 || deployments.length > 200) invalid();
  const models: DeploymentModel[] = [];
  const seen = new Set<string>();
  for (const model of deployments) {
    if (!isObject(model) || !exact(model, ["backendId", "id", "displayName", "createdAt"])) invalid();
    const { backendId, id, displayName, createdAt } = model;
    if (typeof backendId !== "string" || !BACKEND.test(backendId) || typeof id !== "string" || !ID.test(id)
      || typeof displayName !== "string" || !displayName.trim() || displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName)
      || typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAt)
      || !Number.isFinite(Date.parse(createdAt)) || seen.has(`${backendId}|${id}`)) invalid();
    seen.add(`${backendId}|${id}`);
    models.push({ backendId, id, displayName, createdAt });
  }
  return { schemaVersion, tenantId: tenantId.toLowerCase(), clientId: clientId.toLowerCase(),
    scope: `${clientId.toLowerCase()}/${scope.slice(expected.length)}`, gatewayUrl: url.toString().replace(/\/+$/, ""),
    projectHeaderName, refreshMinutes, desktop: { chat: desktop.chat, cowork: desktop.cowork, code: desktop.code }, deployments: models };
}

export function oidcSettings(config: ManagedClientConfig): Record<string, unknown> {
  return {
    issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    clientId: config.clientId, scopes: `openid offline_access ${config.scope}`, redirectHost: "localhost",
  };
}
export function registryBootstrap(config: ManagedClientConfig): string {
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "Windows Registry Editor Version 5.00", "",
    "; Experimental CCOF Desktop trust anchor. Import only through the organization's approved policy process.",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude]",
    `"bootstrapUrl"="${quote(`${config.gatewayUrl}/ccof/client/bootstrap`)}"`,
    `"bootstrapOidc"="${quote(JSON.stringify(oidcSettings(config)))}"`, "",
  ].join("\r\n");
}

export function codeDiscoverySettings(config: ManagedClientConfig) {
  return {
    apiKeyHelper: '"%USERPROFILE%\\.claude\\ccof-token.cmd" token',
    env: {
      ANTHROPIC_BASE_URL: config.gatewayUrl,
      ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_FOUNDRY: "0", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "0", CLAUDE_CODE_USE_MANTLE: "0",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "240000",
    },
  };
}
export function registryCodeDiscovery(config: ManagedClientConfig): string {
  const settings = JSON.stringify(codeDiscoverySettings(config)).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return ["Windows Registry Editor Version 5.00", "",
    "; Requires the approved CCOF Azure CLI helper and a one-time migration of old model pins.",
    "; This replaces Settings: merge into existing organizational policy before deployment.",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode]", `"Settings"="${settings}"`, ""].join("\r\n");
}
