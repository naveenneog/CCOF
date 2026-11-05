import type { HandlerResponse, ResolverRequestContext, ResolverRuntime } from "../resolver/http-handler.ts";
import { handleResolveRequest } from "../resolver/http-handler.ts";
import type { ManagedClientConfig } from "./config.ts";
import { isObject, readManagedClientConfig } from "./config.ts";
import { ClientDiscoveryRefusal, discoveryDocument } from "./documents.ts";

const PERSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export async function handleConfiguredClientDiscoveryRequest(
  request: ResolverRequestContext, runtime: ResolverRuntime, setting: string | undefined,
): Promise<HandlerResponse> {
  if (!request.platformAuthEnabled || !request.authenticatedPrincipal || !runtime.readiness.ready) return handleResolveRequest(request, runtime);
  if (setting === undefined) return { status: 404, jsonBody: { error: "not_found" } };
  let config: ManagedClientConfig;
  try { config = readManagedClientConfig(JSON.parse(setting)); }
  catch {
    runtime.log(JSON.stringify({ schema: "ccof.client-discovery.event.v1", event: "failed", reason: "managed_client_config_invalid", httpStatus: 503 }));
    return { status: 503, jsonBody: { error: "temporarily_unavailable" } };
  }
  return handleClientDiscoveryRequest(request, runtime, config);
}

export async function handleClientDiscoveryRequest(
  request: ResolverRequestContext, runtime: ResolverRuntime, config: ManagedClientConfig,
): Promise<HandlerResponse> {
  // The shared resolver path runs the APIM-only platform gate before parsing or trusting identity fields.
  if (!request.platformAuthEnabled || !request.authenticatedPrincipal || !runtime.readiness.ready) {
    return handleResolveRequest(request, runtime);
  }
  const input = request.body;
  if (!isObject(input) || Object.keys(input).some((key) => !["personId", "projectId", "representation", "requestId"].includes(key))
    || typeof input.personId !== "string" || !PERSON.test(input.personId)
    || (input.representation !== "models" && input.representation !== "bootstrap")
    || (input.projectId !== undefined && (typeof input.projectId !== "string" || !ID.test(input.projectId)))
    || (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(input.requestId)))) {
    runtime.log(JSON.stringify({ schema: "ccof.client-discovery.event.v1", event: "refused", reason: "invalid_request", httpStatus: 400 }));
    return { status: 400, jsonBody: { error: "invalid_request" } };
  }
  const representation = input.representation;
  try {
    return await handleResolveRequest(request, runtime, (decision) => ({
      schema: "ccof.managed-client.v1",
      document: discoveryDocument(config, decision, representation, runtime.now()),
    }));
  } catch (error: unknown) {
    const refused = error instanceof ClientDiscoveryRefusal;
    runtime.log(JSON.stringify({ schema: "ccof.client-discovery.event.v1", event: refused ? "refused" : "failed",
      reason: refused ? error.message : "document_generation_failed", httpStatus: refused ? 403 : 503 }));
    return { status: refused ? 403 : 503, jsonBody: { error: refused ? "not_authorized" : "temporarily_unavailable" } };
  }
}
