// Standalone opt-in operation deployment. The existing API policy and inference path are not changed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig, type GatewayConfig } from "./config.ts";
import { renderPolicy } from "./render.ts";
import { parseApimXml, type XmlElement, type XmlNode } from "./apim-xml.ts";
import { readManagedClientConfig, registryBootstrap, registryCodeDiscovery } from "../../src/managed-clients/config.ts";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function serialize(node: XmlNode): string {
  if (node.kind === "text") return xml(node.value);
  if (node.kind === "comment") return `<!--${node.value}-->`;
  if (node.kind === "cdata") return `<![CDATA[${node.value}]]>`;
  const attributes = node.attributes.map((a) => ` ${a.name}="${a.expression ? a.value : xml(a.value)}"`).join("");
  return `<${node.name}${attributes}>${node.children.map(serialize).join("")}</${node.name}>`;
}
function identityElements(policy: string): string {
  const inbound = parseApimXml(policy).children.find((n): n is XmlElement => n.kind === "element" && n.name === "inbound");
  if (!inbound) throw new Error("managed_client_auth_template_invalid");
  const guards = inbound.children.filter((n): n is XmlElement => n.kind === "element"
    && (n.name === "validate-jwt" || n.attributes.some((a) => a.name === "name" && ["ccofOid", "ccofClientAppId", "ccofRefusal"].includes(a.value))));
  if (guards.length !== 4) throw new Error("managed_client_auth_template_invalid");
  return guards.map(serialize).join("\n");
}
function operationPolicy(config: GatewayConfig, representation: "models" | "bootstrap", guards: string): string {
  const endpoint = config.resolver.url.replace(/\/api\/resolve$/, "/api/me/client-config");
  const errorBody = `{"type":"error","error":{"type":"permission_error","message":"Client configuration is unavailable or not authorized. Contact your platform team."}}`;
  const policy = `<policies><inbound>
${guards}
<choose><when condition="@((string)context.Variables["ccofRefusal"] != "")">
  <return-response><set-status code="403" reason="Forbidden" />
  <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
  <set-header name="Cache-Control" exists-action="override"><value>no-store</value></set-header>
  <set-body>${errorBody}</set-body></return-response>
</when></choose>
<rate-limit-by-key id="ccof-discovery-person" calls="10" renewal-period="60" counter-key="@("ccof-discovery:" + (string)context.Variables["ccofOid"])" retry-after-variable-name="ccofRetryAfter" />
<authentication-managed-identity resource="${xml(config.resolver.tokenAudience)}" output-token-variable-name="ccofResolverToken" ignore-error="true" />
<set-header name="Authorization" exists-action="delete" />
<choose><when condition="@(context.Variables.ContainsKey("ccofResolverToken") &amp;&amp; !string.IsNullOrEmpty((string)context.Variables["ccofResolverToken"]))">
<send-request mode="new" response-variable-name="ccofResolverResponse" timeout="${config.resolver.timeoutSeconds}" ignore-error="true">
  <set-url>${xml(endpoint)}</set-url><set-method>POST</set-method>
  <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
  <set-header name="Authorization" exists-action="override"><value>@("Bearer " + (string)context.Variables["ccofResolverToken"])</value></set-header>
  <set-body>@{
    var body = new JObject(new JProperty("personId", (string)context.Variables["ccofOid"]), new JProperty("representation", "${representation}"), new JProperty("requestId", context.RequestId.ToString()));
    var selector = context.Request.Headers.GetValueOrDefault("${config.resolver.projectHeaderName}", "");
    if (selector != "") { body["projectId"] = selector; }
    return body.ToString(Newtonsoft.Json.Formatting.None);
  }</set-body>
</send-request>
</when></choose>
<set-variable name="ccofResolverToken" value="" />
<set-variable name="ccofDiscoveryBody" value="@{
  var response = context.Variables.ContainsKey("ccofResolverResponse") ? context.Variables["ccofResolverResponse"] as IResponse : null;
  if (response == null || response.StatusCode != 200) { return ""; }
  try {
    var body = response.Body.As&lt;JObject&gt;();
    var document = body["document"] as JObject;
    if ((string)body["schema"] != "ccof.managed-client.v1" || document == null) { return ""; }
    var models = document["${representation === "bootstrap" ? "inferenceModels" : "data"}"] as JArray;
    if (models == null || models.Count == 0) { return ""; }
    ${representation === "bootstrap"
      ? 'if ((string)document["inferenceProvider"] != "gateway" || document["$schemaVersion"] == null || document["$schemaVersion"].Type != JTokenType.Integer || (int)document["$schemaVersion"] != 1) { return ""; }'
      : 'if (document["has_more"] == null || document["has_more"].Type != JTokenType.Boolean || (bool)document["has_more"]) { return ""; }'}
    return document.ToString(Newtonsoft.Json.Formatting.None);
  } catch { return ""; }
}" />
<set-variable name="ccofDiscoveryStatus" value="@{
  if ((string)context.Variables.GetValueOrDefault&lt;object&gt;("ccofDiscoveryBody", "") != "") { return 200; }
  var response = context.Variables.ContainsKey("ccofResolverResponse") ? context.Variables["ccofResolverResponse"] as IResponse : null;
  return response != null &amp;&amp; response.StatusCode == 403 ? 403 : 503;
}" />
<return-response>
  <set-status code="@((int)context.Variables["ccofDiscoveryStatus"])" reason="@((int)context.Variables["ccofDiscoveryStatus"] == 200 ? "OK" : "Client configuration unavailable")" />
  <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
  <set-header name="Cache-Control" exists-action="override"><value>no-store</value></set-header>
  <set-body>@((int)context.Variables["ccofDiscoveryStatus"] == 200 ? (string)context.Variables["ccofDiscoveryBody"] : "${errorBody.replace(/"/g, '\\"')}")</set-body>
</return-response>
</inbound><backend><return-response><set-status code="404" reason="Not Found" /></return-response></backend><outbound />
<on-error><return-response>
  <set-status code="@(context.LastError.Source == "validate-jwt" ? 401 : context.LastError.PolicyId == "ccof-discovery-person" ? 429 : 500)" reason="Client configuration unavailable" />
  <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
  <set-header name="Cache-Control" exists-action="override"><value>no-store</value></set-header>
  <set-body>${errorBody}</set-body>
</return-response></on-error></policies>`;
  parseApimXml(policy);
  return policy;
}

export function renderManagedClientResources(gateway: GatewayConfig, input: unknown) {
  const config = readManagedClientConfig(input);
  const expected = `${gateway.apim.gatewayBaseUrl.replace(/\/$/, "")}/${gateway.apim.apiPath}`.replace(/\/$/, "");
  const modelsKnown = config.deployments.every((m) => Object.hasOwn(gateway.inferenceGeo[m.backendId] ?? {}, m.id));
  if (config.tenantId !== gateway.entra.tenantId.toLowerCase() || config.gatewayUrl !== expected
    || config.projectHeaderName !== gateway.resolver.projectHeaderName || !modelsKnown
    || gateway.entra.authorityHost !== "https://login.microsoftonline.com"
    || !gateway.entra.audiences.some((a) => a.toLowerCase() === config.clientId || a.toLowerCase() === `api://${config.clientId}`)
    || !gateway.entra.delegatedClientAppIds.some((id) => id.toLowerCase() === config.clientId)
    || config.scope !== `${config.clientId}/${gateway.entra.delegatedScope}`) throw new Error("managed_client_gateway_binding_invalid");
  const guards = identityElements(renderPolicy(gateway).usagePolicyXml);
  return {
    registry: registryBootstrap(config), codeRegistry: registryCodeDiscovery(config), config,
    operations: [
      { name: "get-client-bootstrap", method: "GET", urlTemplate: "/ccof/client/bootstrap", policyXml: operationPolicy(gateway, "bootstrap", guards) },
      { name: "get-client-models", method: "GET", urlTemplate: "/v1/models", policyXml: operationPolicy(gateway, "models", guards) },
    ],
  };
}
export function writeManagedClientBundle(gateway: GatewayConfig, input: unknown, out: string) {
  const result = renderManagedClientResources(gateway, input);
  mkdirSync(out, { recursive: true });
  // regedit expects UTF-16LE with a BOM. No registry is changed by this generator.
  writeFileSync(path.join(out, "desktop-bootstrap.reg"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(result.registry, "utf16le")]));
  writeFileSync(path.join(out, "code-discovery.reg"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(result.codeRegistry, "utf16le")]));
  writeFileSync(path.join(out, "resolver-settings.json"), JSON.stringify({ CCOF_MANAGED_CLIENT_CONFIG: JSON.stringify(result.config) }, null, 2));
  writeFileSync(path.join(out, "apim.parameters.json"), JSON.stringify({
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#", contentVersion: "1.0.0.0",
    parameters: { apimName: { value: gateway.apim.serviceName }, apiId: { value: gateway.apim.apiId }, operations: { value: result.operations } },
  }, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error("usage: node infra/gateway/managed-clients.ts <gateway-config.json> <managed-clients.json> <out-dir>");
    const loaded = loadGatewayConfig(process.argv[2]);
    if (!loaded.ok) throw new Error("gateway_config_invalid");
    const result = writeManagedClientBundle(loaded.config, JSON.parse(readFileSync(process.argv[3], "utf8")), process.argv[4]);
    process.stdout.write(JSON.stringify({ event: "managed-client-bundle-written", operations: result.operations.map((o) => o.name), output: path.resolve(process.argv[4]) }) + "\n");
  } catch (error: unknown) {
    process.stderr.write((error instanceof Error ? error.message : "managed_client_bundle_failed") + "\n");
    process.exitCode = 1;
  }
}
