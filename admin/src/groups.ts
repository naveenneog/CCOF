// Group onboarding API (ADR-0034, ROADMAP G6): find an existing Entra group,
// onboard it with its own budget, limits, models, surfaces, priority, chargeback
// ID and cache profile, edit it and retire it. Group documents share the
// `projects` container (kind "group", id = projectId = groupId), so a group
// and a baseline project can never hold the same id. Every write needs the
// stored ETag (except create), is validated by the same contract the sync and
// reconciler read, and is written to the change record first.

import { ApiError, isGuid } from "./auth.ts";
import type { Actor, Authenticator } from "./auth.ts";
import { changes, guardStore, json, parseBody, recorded, requireIfMatch } from "./api.ts";
import type { ApiResponse, ProjectStore, StoredProject } from "./api.ts";
import { beginChange } from "./change-log.ts";
import type { ChangeEntry, ChangeLog } from "./change-log.ts";
import { ValidationError, isObject, stripSystem } from "./validation.ts";
import { isDisplayName } from "./text-rules.ts";
import { BackendNotDeployed, assertDeployed } from "./backend-settings.ts";
import type { BackendSettings } from "./backend-settings.ts";
import type { Doc } from "./validation.ts";
import { readGroupRegistration, SURFACES } from "../../src/contracts/group-registration.ts";
import type { Surface } from "../../src/contracts/group-registration.ts";
import { CACHE_SUGGESTIONS, suggestCacheReadPercent } from "../../src/contracts/cache-suggestions.ts";

export interface DirectoryGroup {
  id: string;
  displayName: string;
  description: string | null;
  securityEnabled: boolean;
  memberCount?: number;
}

export type DirectoryState = "available" | "permission_required" | "unavailable" | "disabled" | "rejected";

export interface DirectoryMember { id: string; displayName: string | null }

export interface GroupDirectory {
  search(text: string, log: (line: string) => void): Promise<{ state: DirectoryState; groups?: DirectoryGroup[] }>;
  get(id: string, log: (line: string) => void): Promise<{ state: DirectoryState | "not_found"; group?: DirectoryGroup }>;
  // Direct user members, so an admin can pick a person to tag (GroupMember.ReadBasic.All).
  members(id: string, log: (line: string) => void): Promise<{ state: DirectoryState | "not_found"; members?: DirectoryMember[]; truncated?: boolean }>;
}

export interface GroupRequest {
  method: string;
  path: string;
  query: (name: string) => string | null;
  headers: (name: string) => string | null;
  body: string | null;
}

export interface GroupApiDependencies {
  authenticate: Authenticator | null;
  store: ProjectStore | null;
  changeLog?: ChangeLog | null;
  directory: GroupDirectory | null;
  // The deployment's backends and model deployments (ADMIN_BACKENDS); absent means not configured.
  backends?: BackendSettings;
  log(line: string): void;
  now(): Date;
  newId(): string;
}

const EDITABLE = ["displayName", "backendId", "priority", "chargebackId", "budget", "restrictedFamiliesApproved", "familyPolicy", "surfaces", "cacheProfile"];
const CREATE_KEYS = ["groupId", ...EDITABLE];
// Graph $search text: no quotes or backslashes, which would end or escape the quoted clause, and not blank.
const SEARCH_TEXT = /^(?=.*\S)[^"\\]{1,100}$/;

type Route =
  | { op: "list" } | { op: "create" } | { op: "read"; groupId: string } | { op: "update"; groupId: string }
  | { op: "retire"; groupId: string } | { op: "search" } | { op: "directoryGroup"; groupId: string } | { op: "directoryMembers"; groupId: string } | { op: "cacheSuggestion" } | { op: "backends" };

const WRITES = new Set(["create", "update", "retire"]);

function route(method: string, path: string): Route | "method_not_allowed" | "group_not_found" | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/").map((p) => decodeURIComponent(p));
  if (parts[0] === "api") parts.shift();
  if (parts[0] !== "groups") return null;
  const m = method.toUpperCase();
  const only = (verb: string, r: Route) => (m === verb ? r : "method_not_allowed" as const);
  if (parts.length === 1) return m === "GET" ? { op: "list" } : m === "POST" ? { op: "create" } : "method_not_allowed";
  if (parts.length === 2 && parts[1] === "directory") return only("GET", { op: "search" });
  if (parts.length === 2 && parts[1] === "cache-suggestion") return only("GET", { op: "cacheSuggestion" });
  if (parts.length === 2 && parts[1] === "backends") return only("GET", { op: "backends" });
  if (parts.length === 3 && parts[1] === "directory") return isGuid(parts[2]) ? only("GET", { op: "directoryGroup", groupId: parts[2].toLowerCase() }) : null;
  if (parts.length === 4 && parts[1] === "directory" && parts[3] === "members") return isGuid(parts[2]) ? only("GET", { op: "directoryMembers", groupId: parts[2].toLowerCase() }) : null;
  const groupId = parts[1];
  // A mistyped or malformed group link names no group (ADMIN-7): say so, rather than "no such route".
  if (!isGuid(groupId)) return parts.length === 2 || (parts.length === 3 && parts[2] === "retire") ? "group_not_found" : null;
  if (parts.length === 2) return m === "GET" ? { op: "read", groupId } : m === "PUT" ? { op: "update", groupId } : "method_not_allowed";
  if (parts.length === 3 && parts[2] === "retire") return only("POST", { op: "retire", groupId });
  return null;
}

// The shared contract only bounds the length; the admin also refuses a name with no visible text or with
// control characters (ADMIN-5), checked when the name is set so an older stored name never blocks other edits.
function assertValidGroup(doc: Doc, nameSet: boolean): Doc {
  const read = readGroupRegistration(doc);
  const problems = read.ok ? [] : [...read.problems];
  if (nameSet && !problems.includes("displayName:invalid") && !isDisplayName(doc.displayName, 256)) problems.push("displayName:invalid");
  if (problems.length > 0) throw new ValidationError(problems);
  return doc;
}

const isGroup = (p: StoredProject | null): p is StoredProject => p !== null && p.doc.kind === "group";

function summary(p: StoredProject) {
  const d = p.doc;
  const budget = isObject(d.budget) ? d.budget : {};
  return {
    groupId: d.groupId, displayName: d.displayName, status: d.status, priority: d.priority, chargebackId: d.chargebackId,
    budgetMode: budget.mode ?? null, surfaces: d.surfaces, backendId: d.backendId, etag: p.etag,
  };
}

function directoryResponse(state: string, payload: Doc): ApiResponse {
  if (state === "available") return json(200, payload);
  if (state === "not_found") throw new ApiError(404, "group_not_found_in_directory");
  if (state === "disabled") throw new ApiError(503, "group_directory_disabled");
  // Graph refused the query text itself (400): an input problem, not an outage.
  if (state === "rejected") throw new ApiError(400, "group_search_rejected");
  throw new ApiError(state === "permission_required" ? 502 : 503, `group_directory_${state}`);
}

function readSurfaces(raw: string | null): Surface[] {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0 || items.some((s) => !(SURFACES as readonly string[]).includes(s))) throw new ApiError(400, "invalid_surfaces");
  return items as Surface[];
}

export async function handleGroupRequest(request: GroupRequest, deps: GroupApiDependencies): Promise<ApiResponse> {
  const requestId = deps.newId();
  const matched = route(request.method, request.path);
  let actor: Actor | null = null;
  let operation = "unknown";
  let groupId: string | undefined;
  const audit = (fields: Record<string, unknown>) => deps.log(JSON.stringify({
    schema: "ccof.admin.audit.v1", at: deps.now().toISOString(), requestId, operation: `group.${operation}`, actorOid: actor?.oid ?? null, projectId: groupId ?? null, ...fields,
  }));
  const begin = (changed: ChangeEntry[], details: Doc = {}) => beginChange(deps.changeLog, {
    requestId, at: deps.now().toISOString(), actorOid: actor?.oid ?? "", operation: `group.${operation}`, projectId: groupId ?? null, changes: changed, details,
  }, deps.now, deps.log);
  try {
    if (!deps.authenticate) throw new ApiError(503, "admin_auth_not_configured");
    actor = await deps.authenticate(request.headers("authorization"));
    if (matched === null) throw new ApiError(404, "route_not_found");
    if (matched === "method_not_allowed") throw new ApiError(405, "method_not_allowed");
    if (matched === "group_not_found") throw new ApiError(404, "group_not_found");
    operation = matched.op;
    groupId = "groupId" in matched ? matched.groupId : undefined;
    if (WRITES.has(matched.op) && !actor.canWrite) throw new ApiError(403, "write_permission_required");

    const backends: BackendSettings = deps.backends ?? { state: "not_configured", backends: [] };
    if (matched.op === "backends") return json(200, { state: backends.state, backends: backends.backends });
    if (matched.op === "cacheSuggestion") {
      const surfaces = readSurfaces(request.query("surfaces"));
      return json(200, { surfaces, suggestion: suggestCacheReadPercent(surfaces), table: CACHE_SUGGESTIONS });
    }
    if (matched.op === "search" || matched.op === "directoryGroup" || matched.op === "directoryMembers") {
      if (!deps.directory) throw new ApiError(503, "group_directory_not_configured");
      if (matched.op === "directoryMembers") {
        // Only an active onboarded group's members are listed, never any other directory group's.
        if (!deps.store) throw new ApiError(503, "project_store_not_configured");
        const onboarded = await guardStore(deps.store).read(matched.groupId);
        if (!isGroup(onboarded) || onboarded.doc.status !== "active") throw new ApiError(404, "group_not_onboarded");
        const found = await deps.directory.members(matched.groupId, deps.log);
        return directoryResponse(found.state, { members: found.members ?? [], truncated: found.truncated === true });
      }
      if (matched.op === "directoryGroup") {
        const found = await deps.directory.get(matched.groupId, deps.log);
        return directoryResponse(found.state, { group: found.group });
      }
      const text = request.query("search") ?? "";
      if (!SEARCH_TEXT.test(text)) throw new ApiError(400, "invalid_search_text");
      const found = await deps.directory.search(text, deps.log);
      return directoryResponse(found.state, { groups: found.groups ?? [] });
    }

    if (!deps.store) throw new ApiError(503, "project_store_not_configured");
    const store = guardStore(deps.store);
    switch (matched.op) {
      case "list": {
        const groups = (await store.list()).filter(isGroup).map(summary)
          .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)) || String(a.groupId).localeCompare(String(b.groupId)));
        return json(200, { groups });
      }
      case "read": {
        const found = await store.read(matched.groupId);
        if (!isGroup(found)) throw new ApiError(404, "group_not_found");
        return json(200, stripSystem(found.doc), { etag: found.etag });
      }
      case "create": {
        const body = parseBody(request);
        if (!isObject(body) || Object.keys(body).some((k) => !CREATE_KEYS.includes(k))) throw new ValidationError(["document:unexpected_key"]);
        const id = typeof body.groupId === "string" ? body.groupId.toLowerCase() : "";
        const doc = assertValidGroup({ ...body, id, kind: "group", groupId: id, projectId: id, status: "active", retiredAt: null }, true);
        groupId = id;
        assertDeployed(doc, null, backends);
        const pending = await begin(changes({}, doc, "", []));
        const written = await recorded(pending, () => store.create(doc));
        if (written === "conflict") { await pending.finish("refused", { code: "group_exists" }); throw new ApiError(409, "group_exists"); }
        await pending.finish("created", { etagAfter: written });
        audit({ outcome: "created", etagAfter: written });
        return json(201, doc, { etag: written, location: `/api/groups/${id}` });
      }
      case "update":
      case "retire": {
        const etag = requireIfMatch(request);
        const body = parseBody(request);
        if (matched.op === "update" && (!isObject(body) || Object.keys(body).length === 0 || Object.keys(body).some((k) => !EDITABLE.includes(k)))) {
          throw new ValidationError(["settings:invalid"]);
        }
        if (matched.op === "retire" && (!isObject(body) || Object.keys(body).length !== 1 || body.confirmGroupId !== matched.groupId)) {
          throw new ValidationError(["confirmGroupId:must_equal_groupId"]);
        }
        const current = await store.read(matched.groupId);
        if (!isGroup(current)) throw new ApiError(404, "group_not_found");
        if (current.etag !== etag) throw new ApiError(412, "etag_mismatch");
        if (current.doc.status === "retired") throw new ApiError(409, "group_retired");
        const before = stripSystem(current.doc);
        const after = matched.op === "retire"
          ? { ...structuredClone(before), status: "retired", retiredAt: deps.now().toISOString() }
          : { ...structuredClone(before), ...structuredClone(body as Doc) };
        assertValidGroup(after, matched.op === "update" && Object.hasOwn(body as Doc, "displayName"));
        if (matched.op === "update") assertDeployed(after, before, backends);
        const changed = changes(before, after, "", []);
        if (changed.length === 0) return json(200, { changed: false, group: before }, { etag });
        const pending = await begin(changed, { etagBefore: etag });
        const written = await recorded(pending, () => store.replace(after, etag));
        if (written === "precondition_failed") { await pending.finish("refused", { code: "etag_mismatch" }); throw new ApiError(412, "etag_mismatch"); }
        const outcome = matched.op === "retire" ? "retired" : "updated";
        await pending.finish(outcome, { etagAfter: written });
        audit({ outcome, etagBefore: etag, etagAfter: written, changes: changed });
        return json(200, { changed: true, group: after }, { etag: written });
      }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (WRITES.has(operation) || err.status === 401 || err.status === 403) audit({ outcome: "refused", status: err.status, code: err.code });
      const body: Record<string, unknown> = { error: err instanceof ValidationError ? "invalid_group" : err.code, requestId };
      if (err instanceof ValidationError || err instanceof BackendNotDeployed) body.problems = err.problems;
      if (err instanceof BackendNotDeployed) body.allowed = err.allowed;
      return json(err.status, body);
    }
    audit({ outcome: "failed", status: 500, code: "internal_error" });
    return json(500, { error: "internal_error", requestId });
  }
}
