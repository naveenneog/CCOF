// Entra group lookup for onboarding (ADR-0034, ROADMAP G6). Uses the admin Function App's managed
// identity with Graph application permissions Group.ReadBasic.All (search and read) and
// GroupMember.ReadBasic.All (direct member count), the read-only least-privileged choices
// (docs/UNKNOWNS.md G-R4). Enabled with ADMIN_GROUP_SEARCH_ENABLED=true. Nothing is cached or logged
// beyond a status code; group names are directory data shown to the administrator only.

import type { TokenCredential } from "@azure/identity";
import { isGuid } from "./auth.ts";
import { isObject } from "./validation.ts";
import type { DirectoryGroup, DirectoryState, GroupDirectory } from "./groups.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,displayName,description,securityEnabled";

class GraphStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`graph_${status}`);
    this.status = status;
  }
}

const stateOf = (status: number): DirectoryState | "not_found" =>
  status === 401 || status === 403 ? "permission_required" : status === 404 ? "not_found" : status === 400 ? "rejected" : "unavailable";

function readGroup(value: unknown): DirectoryGroup | null {
  if (!isObject(value) || !isGuid(value.id) || typeof value.displayName !== "string" || value.displayName.length > 256) return null;
  const description = typeof value.description === "string" ? value.description.slice(0, 1024) : null;
  return { id: value.id.toLowerCase(), displayName: value.displayName, description, securityEnabled: value.securityEnabled === true };
}

export function createGroupDirectory(
  env: Readonly<Record<string, string | undefined>>, credential: TokenCredential,
  transport: typeof fetch = fetch, timeoutMs = 15000,
): GroupDirectory {
  const enabled = env.ADMIN_GROUP_SEARCH_ENABLED === "true";

  async function call(url: string, signal: AbortSignal): Promise<Response> {
    const token = await credential.getToken("https://graph.microsoft.com/.default", { abortSignal: signal });
    if (!token) throw new GraphStatus(401);
    const res = await transport(url, {
      method: "GET", redirect: "error", signal,
      headers: { authorization: `Bearer ${token.token}`, ConsistencyLevel: "eventual" },
    });
    if (!res.ok) throw new GraphStatus(res.status);
    return res;
  }

  async function guarded<T>(log: (line: string) => void, work: (signal: AbortSignal) => Promise<T>): Promise<T | { state: DirectoryState | "not_found" }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await work(controller.signal);
    } catch (err) {
      const status = err instanceof GraphStatus ? err.status : null;
      log(JSON.stringify({ schema: "ccof.admin.groupdirectory.v1", status, code: status === null ? "group_directory_request_failed" : `graph_${status}` }));
      return { state: status === null ? "unavailable" : stateOf(status) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async search(text, log) {
      if (!enabled) return { state: "disabled" };
      const result = await guarded(log, async (signal) => {
        const params = new URLSearchParams({
          $search: `"displayName:${text}"`, $filter: "securityEnabled eq true", $select: SELECT, $top: "25", $count: "true",
        });
        const body: unknown = await (await call(`${GRAPH}/groups?${params}`, signal)).json();
        if (!isObject(body) || !Array.isArray(body.value)) throw new GraphStatus(502);
        return { state: "available" as const, groups: body.value.map(readGroup).filter((g): g is DirectoryGroup => g !== null) };
      });
      return result.state === "not_found" ? { state: "unavailable" } : result as { state: DirectoryState; groups?: DirectoryGroup[] };
    },
    async members(id, log) {
      if (!enabled) return { state: "disabled" };
      return guarded(log, async (signal) => {
        const body: unknown = await (await call(`${GRAPH}/groups/${id}/members/microsoft.graph.user?$select=id,displayName&$top=999`, signal)).json();
        if (!isObject(body) || !Array.isArray(body.value)) throw new GraphStatus(502);
        const members = body.value.filter(isObject).filter((m) => isGuid(m.id)).map((m) => ({
          id: (m.id as string).toLowerCase(), displayName: typeof m.displayName === "string" ? m.displayName.slice(0, 256) : null,
        }));
        return { state: "available" as const, members, truncated: typeof body["@odata.nextLink"] === "string" };
      });
    },
    async get(id, log) {
      if (!enabled) return { state: "disabled" };
      return guarded(log, async (signal) => {
        const groupBody: unknown = await (await call(`${GRAPH}/groups/${id}?$select=${SELECT}`, signal)).json();
        const group = readGroup(groupBody);
        if (!group || group.id !== id.toLowerCase()) throw new GraphStatus(502);
        const countText = (await (await call(`${GRAPH}/groups/${id}/members/$count`, signal)).text()).trim();
        if (!/^\d{1,9}$/.test(countText)) throw new GraphStatus(502);
        return { state: "available" as const, group: { ...group, memberCount: Number(countText) } };
      });
    },
  };
}
