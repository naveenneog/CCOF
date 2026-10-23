// Renders the claude-messages policy from a validated gateway configuration.
//
//   node infra/gateway/render.ts --config infra/gateway/config/<env>.json [--out <dir>]
//
// The template (policy/claude-messages.template.xml) and the backend fragments
// carry no environment value: this module derives every value from the
// configuration, refuses a template that carries a literal (template.ts), and
// checks the result is a well-formed policy with no placeholder left and no
// named value other than the configured backend secrets. Output goes to
// infra/gateway/out/ (git-ignored) as <apiId>.policy.xml plus render.json with
// the configuration, template and policy digests the deploy script records.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseApimXml } from "./apim-xml.ts";
import type { BackendConfig, GatewayConfig } from "./config.ts";
import { loadGatewayConfig, validateGatewayConfig } from "./config.ts";
import type { TemplateValue } from "./template.ts";
import { fillPlaceholders, findTemplateLiterals, placeholdersIn } from "./template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(HERE, "policy");
export const DEFAULT_OUT_DIR = path.join(HERE, "out");

export interface Templates {
  main: string;
  fragments: Record<string, string>;
  // The GET /ccof/me/usage operation policy (policy/my-usage.template.xml); loaded from disk when absent.
  usage?: string;
}

export interface RenderResult {
  configurationId: string;
  apiId: string;
  policyXml: string;
  policySha256: string;
  configSha256: string;
  templateSha256: string;
  usagePolicyXml: string;
  usagePolicySha256: string;
  usageTemplateSha256: string;
  // The form deployed to API Management: policyXml split into one fragment per section (ADR-0039).
  deployment: PolicyDeployment;
}

export interface PolicyFragment {
  id: string;
  xml: string;
}

export interface PolicyDeployment {
  apiPolicyXml: string;
  fragments: PolicyFragment[];
}

// API Management refuses an API policy over 16 KB ("Policy size exceeds allowed limit of 16 KB",
// Standard v2 instance created 2026-10-23); policy fragments of 68 KB were accepted (ADR-0039).
export const API_POLICY_LIMIT_BYTES = 16 * 1024;
const POLICY_SECTIONS = ["inbound", "backend", "outbound", "on-error"] as const;

// Moves each section's content into a policy fragment and leaves the API policy with the section's
// leading <base /> (where it had one) and an <include-fragment>. Putting each fragment's content back
// in place of its <include-fragment> gives policyXml byte for byte (tests/gateway-policy-fragments.test.ts).
export function splitPolicyForDeployment(policyXml: string, apiId: string): PolicyDeployment {
  // The gateway schema's apiId pattern, shortened so the longest fragment name ("-on-error-" + 12 hex) stays
  // within APIM's 80-character fragment name limit.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,57}$/.test(apiId)) throw new Error(`apiId "${apiId}" cannot name a policy fragment (at most 58 characters, letters, digits, _ and -)`);
  let apiPolicyXml = policyXml;
  const fragments: PolicyFragment[] = [];
  for (const section of POLICY_SECTIONS) {
    const open = `<${section}>`;
    const close = `</${section}>`;
    if (apiPolicyXml.split(open).length !== 2 || apiPolicyXml.split(close).length !== 2) {
      throw new Error(`the rendered policy must contain exactly one ${open} and one ${close}`);
    }
    const start = apiPolicyXml.indexOf(open) + open.length;
    const end = apiPolicyXml.indexOf(close);
    const inner = apiPolicyXml.slice(start, end);
    const base = /^\s*<base\s*\/>/.exec(inner)?.[0] ?? "";
    const xml = `<fragment>${inner.slice(base.length)}</fragment>`;
    // Content-addressed: a changed section gets a new fragment, so the live API policy keeps its own
    // fragments until the new API policy replaces it (and an API revision keeps its fragments).
    const id = `${apiId}-${section}-${sha256(xml).slice(0, 12)}`;
    fragments.push({ id, xml });
    apiPolicyXml = `${apiPolicyXml.slice(0, start)}${base}<include-fragment fragment-id="${id}" />${apiPolicyXml.slice(end)}`;
  }
  if (Buffer.byteLength(apiPolicyXml, "utf8") >= API_POLICY_LIMIT_BYTES) throw new Error("the API policy is still over the API Management limit after the split");
  return { apiPolicyXml, fragments };
}

// admission.usage is optional (docs/USAGE.md): a configuration written before the usage operation existed
// still renders, with this per-person limit for GET /ccof/me/usage.
export const DEFAULT_USAGE_ADMISSION = { calls: 10, renewalPeriodSeconds: 60 } as const;

// Static backends need a secret named value in the policy; every other
// backend is routed by data (C-8) through the template's generic branches.
const FRAGMENT_FOR: Record<BackendConfig["credential"]["type"], string> = {
  crossTenantClientCredentials: "backend-cross-tenant-client-credentials",
};

export function loadTemplates(): Templates {
  const read = (name: string) => readFileSync(path.join(POLICY_DIR, name), "utf8");
  return {
    main: read("claude-messages.template.xml"),
    fragments: Object.fromEntries(Object.values(FRAGMENT_FOR).map((name) => [name, read(`${name}.xml`)])),
    usage: read("my-usage.template.xml"),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// Key order does not change the digest: the same settings give the same stamp.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "$schema").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const csharpStrings = (items: string[]) => ({ xml: items.map((s) => `"${s}"`).join(", ") });

function backendValues(backend: BackendConfig): Record<string, TemplateValue> {
  const credential = backend.credential;
  return {
    BACKEND_ID: backend.id,
    CLIENT_SECRET_NAMED_VALUE: credential.clientSecretNamedValue,
    TOKEN_URL: `${credential.authorityHost}/${credential.tenantId}/oauth2/v2.0/token`,
    CLIENT_ID: credential.clientId,
    SCOPE: credential.scope,
    TOKEN_TIMEOUT: String(credential.tokenRequestTimeoutSeconds),
  };
}

function mainValues(config: GatewayConfig, backendBranches: string, digests: { config: string; template: string }): Record<string, TemplateValue> {
  const { entra, admission, resolver, entitlementCache: cache, tokenLimits, forwarding } = config;
  const tenant = entra.tenantId;
  const geoEntries = Object.entries(config.inferenceGeo).flatMap(([backendId, map]) => Object.entries(map).map(([deployment, geo]) => `${backendId}|${deployment}=${geo}`));
  return {
    CONFIGURATION_ID: config.configurationId,
    CONFIG_SHA256: digests.config,
    TEMPLATE_SHA256: digests.template,
    TENANT_ID: tenant,
    OPENID_CONFIG_URL: `${entra.authorityHost}/${tenant}/v2.0/.well-known/openid-configuration`,
    ISSUER_V1: `${entra.v1IssuerHost}/${tenant}/`,
    ISSUER_V2: `${entra.authorityHost}/${tenant}/v2.0`,
    AUDIENCE_ELEMENTS: { xml: entra.audiences.map((a) => `<audience>${a}</audience>`).join("\n        ") },
    DELEGATED_SCOPE: entra.delegatedScope,
    DELEGATED_CLIENT_IDS: csharpStrings(entra.delegatedClientAppIds),
    ALLOW_APP_ONLY: String(entra.testIdentities.allowAppOnlyTokens),
    APP_ONLY_CLIENT_IDS: csharpStrings(entra.testIdentities.clientAppIds),
    APP_ONLY_ROLE: entra.testIdentities.appRole ?? "",
    SURFACE_ENFORCED: String(entra.surfaceClients.length > 0),
    SURFACE_CLIENT_IDS: csharpStrings(entra.surfaceClients.map((c) => c.clientAppId.toLowerCase())),
    SURFACE_NAMES: csharpStrings(entra.surfaceClients.map((c) => c.surface)),
    PERSON_CALLS: String(admission.perPerson.calls),
    PERSON_PERIOD: String(admission.perPerson.renewalPeriodSeconds),
    MISS_CALLS: String(admission.resolverMisses.calls),
    MISS_PERIOD: String(admission.resolverMisses.renewalPeriodSeconds),
    MISS_CONCURRENCY: String(admission.resolverMisses.maxConcurrent),
    RESOLVER_URL: resolver.url,
    RESOLVER_AUDIENCE: resolver.tokenAudience,
    RESOLVER_TIMEOUT: String(resolver.timeoutSeconds),
    PROJECT_HEADER: resolver.projectHeaderName,
    CACHE_KEY_VERSION: String(cache.keyVersion),
    CACHING_TYPE: cache.cachingType,
    ALLOW_TTL: String(cache.allowTtlSeconds),
    REFUSAL_TTL: String(cache.refusalTtlSeconds),
    LKG_GRACE: String(cache.lastKnownGoodGraceSeconds),
    REFRESH_BACKOFF: String(cache.refreshBackoffSeconds),
    RETRY_AFTER: String(cache.unavailableRetryAfterSeconds),
    ESTIMATE_PROMPT_TOKENS: String(tokenLimits.estimatePromptTokens),
    H_PERSON_QUOTA: tokenLimits.headers.personRemainingQuota,
    H_PERSON_TOKENS: tokenLimits.headers.personRemainingTokens,
    H_GROUP_QUOTA: tokenLimits.headers.groupRemainingQuota,
    H_GROUP_TOKENS: tokenLimits.headers.groupRemainingTokens,
    H_TOKENS_CONSUMED: tokenLimits.headers.tokensConsumed,
    BACKEND_IDS: csharpStrings(config.backends.map((b) => b.id)),
    INFERENCE_GEO_ENTRIES: csharpStrings(geoEntries),
    BACKEND_BRANCHES: { xml: backendBranches },
    ANTHROPIC_VERSION_DEFAULT: {
      xml: forwarding.defaultAnthropicVersion === null
        ? ""
        : `<set-header name="anthropic-version" exists-action="skip">\n          <value>${forwarding.defaultAnthropicVersion}</value>\n        </set-header>`,
    },
  };
}

// The usage operation's values: the same token checks and resolver identity as the messages policy, the
// resolver's /api/me/usage route next to /api/resolve, and the operation's own per-person limit.
function usageValues(config: GatewayConfig, digests: { config: string; template: string }): Record<string, TemplateValue> {
  const { entra, resolver, entitlementCache: cache } = config;
  const tenant = entra.tenantId;
  if (!/\/api\/resolve$/.test(resolver.url)) throw new Error("resolver.url must end with /api/resolve: the usage route is derived from it");
  const admission = config.admission.usage ?? DEFAULT_USAGE_ADMISSION;
  return {
    CONFIGURATION_ID: config.configurationId,
    CONFIG_SHA256: digests.config,
    TEMPLATE_SHA256: digests.template,
    TENANT_ID: tenant,
    OPENID_CONFIG_URL: `${entra.authorityHost}/${tenant}/v2.0/.well-known/openid-configuration`,
    ISSUER_V1: `${entra.v1IssuerHost}/${tenant}/`,
    ISSUER_V2: `${entra.authorityHost}/${tenant}/v2.0`,
    AUDIENCE_ELEMENTS: { xml: entra.audiences.map((a) => `<audience>${a}</audience>`).join("\n        ") },
    DELEGATED_SCOPE: entra.delegatedScope,
    DELEGATED_CLIENT_IDS: csharpStrings(entra.delegatedClientAppIds),
    ALLOW_APP_ONLY: String(entra.testIdentities.allowAppOnlyTokens),
    APP_ONLY_CLIENT_IDS: csharpStrings(entra.testIdentities.clientAppIds),
    APP_ONLY_ROLE: entra.testIdentities.appRole ?? "",
    USAGE_CALLS: String(admission.calls),
    USAGE_PERIOD: String(admission.renewalPeriodSeconds),
    RESOLVER_USAGE_URL: resolver.url.replace(/\/api\/resolve$/, "/api/me/usage"),
    RESOLVER_AUDIENCE: resolver.tokenAudience,
    RESOLVER_TIMEOUT: String(resolver.timeoutSeconds),
    RETRY_AFTER: String(cache.unavailableRetryAfterSeconds),
  };
}

// Every value offered to a template must be used by it: a renamed or deleted
// placeholder must not silently drop a configured setting.
function fill(text: string, values: Record<string, TemplateValue>, name: string): string {
  const used = new Set(placeholdersIn(text));
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length > 0) throw new Error(`${name}: value(s) never used by the template: ${unused.join(", ")}`);
  return fillPlaceholders(text, values, name);
}

export function renderPolicy(input: GatewayConfig, options: { templates?: Templates } = {}): RenderResult {
  const validation = validateGatewayConfig(input);
  if (!validation.ok) throw new Error(`the configuration is invalid:\n - ${validation.problems.join("\n - ")}`);
  const config = validation.config;
  // A Windows checkout has CRLF and CI has LF: both must give the same policy and digests.
  const lf = (text: string) => text.replace(/\r\n/g, "\n");
  const given = options.templates ?? loadTemplates();
  const templates: Templates = {
    main: lf(given.main),
    fragments: Object.fromEntries(Object.entries(given.fragments).map(([name, text]) => [name, lf(text)])),
    usage: lf(given.usage ?? loadTemplates().usage ?? ""),
  };
  const usageTemplate = templates.usage as string;

  const literals = [["main", templates.main], ["usage", usageTemplate], ...Object.entries(templates.fragments)].flatMap(([name, text]) => findTemplateLiterals(text, name));
  if (literals.length > 0) throw new Error(`the template carries a literal environment value:\n - ${literals.join("\n - ")}`);

  const digests = {
    config: sha256(canonicalJson(config)),
    template: sha256([templates.main, ...Object.keys(templates.fragments).sort().map((k) => `${k}\n${templates.fragments[k]}`)].join("\n--\n")),
  };
  const branches = config.backends
    .map((backend) => {
      const fragment = FRAGMENT_FOR[backend.credential.type];
      return fill(templates.fragments[fragment], backendValues(backend), `${fragment} (${backend.id})`).trim();
    })
    .join("\n");
  const policyXml = fill(templates.main, mainValues(config, branches, digests), "main");
  checkRendered(policyXml, config);
  const usageTemplateSha256 = sha256(usageTemplate);
  const usagePolicyXml = fill(usageTemplate, usageValues(config, { config: digests.config, template: usageTemplateSha256 }), "usage");
  checkRendered(usagePolicyXml, config);
  return {
    configurationId: config.configurationId,
    apiId: config.apim.apiId,
    policyXml,
    policySha256: sha256(policyXml),
    configSha256: digests.config,
    templateSha256: digests.template,
    usagePolicyXml,
    usagePolicySha256: sha256(usagePolicyXml),
    usageTemplateSha256,
    deployment: splitPolicyForDeployment(policyXml, config.apim.apiId),
  };
}

function checkRendered(policyXml: string, config: GatewayConfig): void {
  if (policyXml.includes("%%")) throw new Error("the rendered policy still contains a placeholder");
  const root = parseApimXml(policyXml);
  if (root.name !== "policies") throw new Error("the rendered policy's root is not <policies>");
  const allowed = new Set(config.backends.map((b) => b.credential.clientSecretNamedValue));
  for (const match of policyXml.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!allowed.has(match[1])) throw new Error(`the rendered policy references named value "${match[1]}", which is not a configured backend secret`);
  }
}

export function renderFromFile(configPath: string, outDir: string): { result: RenderResult; policyPath: string; usagePolicyPath: string; deploymentPath: string; manifestPath: string } {
  const loaded = loadGatewayConfig(configPath);
  if (!loaded.ok) throw new Error(`configuration ${configPath} is invalid:\n - ${loaded.problems.join("\n - ")}`);
  const result = renderPolicy(loaded.config);
  mkdirSync(outDir, { recursive: true });
  const policyPath = path.join(outDir, `${result.apiId}.policy.xml`);
  const usagePolicyPath = path.join(outDir, `${result.apiId}.usage.policy.xml`);
  const deploymentPath = path.join(outDir, `${result.apiId}.policy.deployment.json`);
  const manifestPath = path.join(outDir, "render.json");
  writeFileSync(policyPath, result.policyXml, "utf8");
  writeFileSync(usagePolicyPath, result.usagePolicyXml, "utf8");
  writeFileSync(deploymentPath, `${JSON.stringify(result.deployment, null, 2)}\n`, "utf8");
  const { policyXml: _omitted, usagePolicyXml: _omittedUsage, deployment: _omittedDeployment, ...manifest } = result;
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, policyFile: path.basename(policyPath), usagePolicyFile: path.basename(usagePolicyPath), deploymentFile: path.basename(deploymentPath) }, null, 2)}\n`, "utf8");
  return { result, policyPath, usagePolicyPath, deploymentPath, manifestPath };
}

function main(argv: string[]): number {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      process.stderr.write("usage: node infra/gateway/render.ts --config <file> [--out <dir>]\n");
      return 2;
    }
    args.set(argv[i].slice(2), argv[i + 1]);
  }
  const configPath = args.get("config");
  if (!configPath) {
    process.stderr.write("usage: node infra/gateway/render.ts --config <file> [--out <dir>]\n");
    return 2;
  }
  try {
    const loaded = loadGatewayConfig(configPath);
    const outDir = args.get("out") ?? path.join(DEFAULT_OUT_DIR, loaded.ok ? loaded.config.configurationId : "invalid");
    const { result, policyPath, usagePolicyPath, deploymentPath, manifestPath } = renderFromFile(configPath, outDir);
    const { policyXml: _omitted, usagePolicyXml: _omittedUsage, deployment: _omittedDeployment, ...summary } = result;
    process.stdout.write(`${JSON.stringify({ ...summary, policyPath, usagePolicyPath, deploymentPath, manifestPath })}\n`);
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
