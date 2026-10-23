// Individual user tags (owner decision 2026-10-23, UNKNOWNS G-A2; src/contracts/user-tags.ts). An admin
// tags a person with a chargeback ID when onboarding them; every new tag is saved and suggested while
// typing. The sync copies the tag into the person's group memberships, so usage carries it from the
// next sync on. Documents live in adminConfig (partition key /scopeId = id). Every change is written to
// the change record first; a person's tag is changed with its ETag, or created with If-None-Match: *.
//
//   GET /api/user-tags?search=text           saved tags matching the text (suggestions)
//   GET /api/user-tags/people?tag=&limit=    tagged people, optionally one tag
//   GET /api/user-tags/people/{personId}     one person's tag and ETag
//   PUT /api/user-tags/people/{personId}     { "tag": "WBS-1.2" | null }  (editor)

import type { Container } from "@azure/cosmos";
import { ApiError, isGuid } from "./auth.ts";
import type { Actor, Authenticator } from "./auth.ts";
import { json, parseBody, recorded, requireIfMatch } from "./api.ts";
import type { ApiResponse } from "./api.ts";
import { beginChange } from "./change-log.ts";
import type { ChangeLog } from "./change-log.ts";
import { ValidationError, isObject, stripSystem } from "./validation.ts";
import type { Doc } from "./validation.ts";
import {
  MAX_SAVED_TAGS, USER_TAG_CATALOG_ID, USER_TAG_KIND, isUserTag, mergeSavedTags, readUserTagDocument, suggestTags, userTagDocumentId,
  DEFAULT_USER_TAG_LABEL, USER_TAG_SETTINGS_ID, isUserTagLabel,
} from "../../src/contracts/user-tags.ts";

export interface UserTagStore {
  read(personId: string): Promise<{ doc: Doc; etag: string } | null>;
  create(doc: Doc): Promise<string | "conflict">;
  replace(doc: Doc, etag: string): Promise<string | "precondition_failed">;
  list(tag: string | null, limit: number): Promise<{ doc: Doc; etag: string }[]>;
  readSaved(): Promise<{ tags: string[]; etag: string } | null>;
  // The new ETag, or null when the stored list changed meanwhile (or appeared).
  writeSaved(tags: string[], etag: string | null): Promise<string | null>;
  readSettings(): Promise<{ label: string; etag: string } | null>;
  writeSettings(doc: Doc, etag: string | null): Promise<string | null>;
}

export interface UserTagRequest {
  method: string;
  path: string;
  query: (name: string) => string | null;
  headers: (name: string) => string | null;
  body: string | null;
}

export interface UserTagDependencies {
  authenticate: Authenticator | null;
  store: UserTagStore | null;
  changeLog?: ChangeLog | null;
  log(line: string): void;
  now(): Date;
  newId(): string;
}

export const MAX_LISTED_PEOPLE = 500;
const SEARCH_TEXT = /^[A-Za-z0-9._\/-]{0,64}$/;

type Route = { op: "suggest" } | { op: "list" } | { op: "settings"; write: boolean } | { op: "read"; personId: string } | { op: "set"; personId: string };

function route(method: string, path: string): Route | "method_not_allowed" | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/").map((p) => decodeURIComponent(p));
  if (parts[0] === "api") parts.shift();
  if (parts[0] !== "user-tags") return null;
  const m = method.toUpperCase();
  if (parts.length === 1) return m === "GET" ? { op: "suggest" } : "method_not_allowed";
  if (parts.length === 2 && parts[1] === "settings") return ["GET", "PUT"].includes(m) ? { op: "settings", write: m === "PUT" } : "method_not_allowed";
  if (parts[1] !== "people") return null;
  if (parts.length === 2) return m === "GET" ? { op: "list" } : "method_not_allowed";
  if (parts.length !== 3 || !isGuid(parts[2])) return null;
  const personId = parts[2].toLowerCase();
  return m === "GET" ? { op: "read", personId } : m === "PUT" ? { op: "set", personId } : "method_not_allowed";
}

const view = (doc: Doc, etag: string) => {
  const d = stripSystem(doc);
  return { personId: d.personId, tag: d.tag ?? null, updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null, etag };
};

// Adds the tag to the saved list, retrying a concurrent change of the list a few times. False when it
// could not be saved (list full or busy); the tag itself is already written by then.
async function saveTag(store: UserTagStore, tag: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await store.readSaved();
    let next: string[];
    try { next = mergeSavedTags(current?.tags ?? [], tag); } catch { return false; }
    if (current && next.length === current.tags.length) return true;
    if (await store.writeSaved(next, current?.etag ?? null) !== null) return true;
  }
  return false;
}

// Refuses a new tag the saved list has no room for, before anything is written.
async function assertRoomForTag(store: UserTagStore, tag: string): Promise<void> {
  const saved = (await store.readSaved())?.tags ?? [];
  if (!saved.includes(tag) && saved.length >= MAX_SAVED_TAGS) throw new ApiError(409, "saved_tags_full");
}

export async function handleUserTagRequest(request: UserTagRequest, deps: UserTagDependencies): Promise<ApiResponse> {
  const requestId = deps.newId();
  const matched = route(request.method, request.path);
  let actor: Actor | null = null;
  let operation = "unknown";
  let personId: string | null = null;
  const audit = (fields: Record<string, unknown>) => deps.log(JSON.stringify({
    schema: "ccof.admin.audit.v1", at: deps.now().toISOString(), requestId, operation: `userTag.${operation}`, actorOid: actor?.oid ?? null, personId, ...fields,
  }));
  try {
    if (!deps.authenticate) throw new ApiError(503, "admin_auth_not_configured");
    actor = await deps.authenticate(request.headers("authorization"));
    if (matched === null) throw new ApiError(404, "route_not_found");
    if (matched === "method_not_allowed") throw new ApiError(405, "method_not_allowed");
    operation = matched.op;
    personId = "personId" in matched ? matched.personId : null;
    if ((matched.op === "set" || matched.op === "settings" && matched.write) && !actor.canWrite) throw new ApiError(403, "write_permission_required");
    if (!deps.store) throw new ApiError(503, "user_tags_not_configured");
    const store = deps.store;

    switch (matched.op) {
      case "settings": {
        if (!matched.write) {
          const current = await store.readSettings();
          return json(200, { label: current?.label ?? DEFAULT_USER_TAG_LABEL, exists: current !== null, etag: current?.etag ?? null }, current ? { etag: current.etag } : {});
        }
        const body = parseBody(request);
        if (!isObject(body) || Object.keys(body).length !== 1 || !isUserTagLabel(body.label)) throw new ValidationError(["label:invalid"]);
        const creating = request.headers("if-none-match")?.trim() === "*";
        const etag = creating ? null : requireIfMatch(request);
        const current = await store.readSettings();
        if ((current?.etag ?? null) !== etag) throw new ApiError(412, "etag_mismatch");
        if (!creating && !current) throw new ApiError(404, "user_tag_settings_not_found");
        const id = USER_TAG_SETTINGS_ID;
        const doc = { id, scopeId: id, kind: id, schemaVersion: 1, label: body.label, updatedAt: deps.now().toISOString(), updatedBy: actor.oid };
        const pending = await beginChange(deps.changeLog, {
          requestId, at: deps.now().toISOString(), actorOid: actor.oid, operation: "userTag.settings", projectId: null,
          changes: [{ path: "label", before: current?.label ?? DEFAULT_USER_TAG_LABEL, after: body.label }], details: {},
        }, deps.now, deps.log);
        const written = await recorded(pending, () => store.writeSettings(doc, etag));
        if (written === null) {
          await pending.finish("refused", { code: "etag_mismatch" });
          throw new ApiError(412, "etag_mismatch");
        }
        await pending.finish(current ? "updated" : "created", { etagAfter: written });
        audit({ outcome: current ? "updated" : "created", before: current?.label ?? DEFAULT_USER_TAG_LABEL, after: body.label });
        return json(current ? 200 : 201, { label: body.label, exists: true, etag: written }, { etag: written });
      }
      case "suggest": {
        const text = request.query("search") ?? "";
        if (!SEARCH_TEXT.test(text)) throw new ApiError(400, "invalid_search_text");
        const saved = (await store.readSaved())?.tags ?? [];
        return json(200, { tags: suggestTags(saved, text), savedCount: saved.length, maxSaved: MAX_SAVED_TAGS });
      }
      case "list": {
        const tag = request.query("tag");
        if (tag !== null && !isUserTag(tag)) throw new ApiError(400, "invalid_tag_filter");
        const limitText = request.query("limit") ?? String(MAX_LISTED_PEOPLE);
        const limit = Number(limitText);
        if (!/^\d{1,3}$/.test(limitText) || limit < 1 || limit > MAX_LISTED_PEOPLE) throw new ApiError(400, "invalid_limit");
        const rows = (await store.list(tag, limit + 1)).filter((r) => readUserTagDocument(r.doc) !== null);
        return json(200, { people: rows.slice(0, limit).map((r) => view(r.doc, r.etag)), truncated: rows.length > limit });
      }
      case "read": {
        // A person without a tag is a normal state, not an error: 200 with exists false and no ETag.
        const found = await store.read(matched.personId);
        if (!found || !readUserTagDocument(found.doc)) return json(200, { personId: matched.personId, tag: null, updatedAt: null, updatedBy: null, etag: null, exists: false });
        return json(200, { ...view(found.doc, found.etag), exists: true }, { etag: found.etag });
      }
      case "set": {
        const body = parseBody(request);
        if (!isObject(body) || Object.keys(body).length !== 1 || !("tag" in body)) throw new ValidationError(["document:unexpected_key"]);
        const tag = body.tag === null || body.tag === "" ? null : body.tag;
        if (tag !== null && !isUserTag(tag)) throw new ValidationError(["tag:invalid"]);
        const creating = request.headers("if-none-match")?.trim() === "*";
        const etag = creating ? null : requireIfMatch(request);
        const current = await store.read(matched.personId);
        if (creating && current) throw new ApiError(412, "user_tag_exists");
        if (!creating && (!current || current.etag !== etag)) throw new ApiError(current ? 412 : 404, current ? "etag_mismatch" : "user_tag_not_found");
        const before = current ? (readUserTagDocument(current.doc)?.tag ?? null) : null;
        if (current && before === tag) return json(200, { changed: false, ...view(current.doc, current.etag) }, { etag: current.etag });
        if (tag !== null) await assertRoomForTag(store, tag as string);
        const id = userTagDocumentId(matched.personId);
        const doc: Doc = { id, scopeId: id, kind: USER_TAG_KIND, schemaVersion: 1, personId: matched.personId, tag, updatedAt: deps.now().toISOString(), updatedBy: actor.oid };
        const pending = await beginChange(deps.changeLog, {
          requestId, at: deps.now().toISOString(), actorOid: actor.oid, operation: "userTag.set", projectId: null,
          changes: [{ path: "tag", before, after: tag }], details: { personId: matched.personId },
        }, deps.now, deps.log);
        const written = await recorded(pending, () => (etag === null ? store.create(doc) : store.replace(doc, etag)));
        if (written === "conflict" || written === "precondition_failed") {
          await pending.finish("refused", { code: "etag_mismatch" });
          throw new ApiError(412, "etag_mismatch");
        }
        // Saved for suggestions only once the tag itself is written, so a refused change suggests nothing.
        const suggestionSaved = tag === null ? null : await saveTag(store, tag as string).catch(() => false);
        await pending.finish(current ? "updated" : "created", { etagAfter: written, suggestionSaved });
        audit({ outcome: current ? "updated" : "created", before, after: tag, suggestionSaved });
        return json(current ? 200 : 201, { changed: true, ...view(doc, written), suggestionSaved }, { etag: written });
      }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (operation === "set" || operation === "settings" || err.status === 401 || err.status === 403) audit({ outcome: "refused", status: err.status, code: err.code });
      const body: Record<string, unknown> = { error: err instanceof ValidationError ? "invalid_user_tag" : err.code, requestId };
      if (err instanceof ValidationError) body.problems = err.problems;
      return json(err.status, body);
    }
    audit({ outcome: "failed", status: 500, code: "internal_error" });
    return json(500, { error: "internal_error", requestId });
  }
}

const statusOf = (err: unknown) => (err as { code?: number })?.code ?? 0;

export function createCosmosUserTagStore(container: Container): UserTagStore {
  const readItem = async (id: string) => {
    try {
      const r = await container.item(id, id).read<Doc>();
      return r.resource ? { doc: r.resource, etag: r.etag ?? "" } : null;
    } catch (err) { if (statusOf(err) === 404) return null; throw err; }
  };
  return {
    async readSettings() {
      const found = await readItem(USER_TAG_SETTINGS_ID);
      if (!found) return null;
      const d = found.doc;
      if (d.id !== USER_TAG_SETTINGS_ID || d.scopeId !== USER_TAG_SETTINGS_ID || d.kind !== USER_TAG_SETTINGS_ID || d.schemaVersion !== 1 || !isUserTagLabel(d.label) || !found.etag) throw new Error("user_tag_settings_invalid");
      return { label: d.label, etag: found.etag };
    },
    async writeSettings(doc, etag) {
      try {
        const r = etag === null ? await container.items.create(doc)
          : await container.item(USER_TAG_SETTINGS_ID, USER_TAG_SETTINGS_ID).replace(doc, { accessCondition: { type: "IfMatch", condition: etag } });
        if (!r.etag) throw new Error("user_tag_settings_etag_missing");
        return r.etag;
      } catch (err) { if ([404, 409, 412].includes(statusOf(err))) return null; throw err; }
    },
    read: (personId) => readItem(userTagDocumentId(personId)),
    async create(doc) {
      try { return (await container.items.create(doc)).etag ?? ""; } catch (err) { if (statusOf(err) === 409) return "conflict"; throw err; }
    },
    async replace(doc, etag) {
      const id = String(doc.id);
      try { return (await container.item(id, id).replace(doc, { accessCondition: { type: "IfMatch", condition: etag } })).etag ?? ""; }
      catch (err) { if ([404, 412].includes(statusOf(err))) return "precondition_failed"; throw err; }
    },
    async list(tag, limit) {
      const query = tag === null
        ? { query: "SELECT TOP @limit * FROM c WHERE c.kind = @kind ORDER BY c.personId", parameters: [{ name: "@kind", value: USER_TAG_KIND }, { name: "@limit", value: limit }] }
        : { query: "SELECT TOP @limit * FROM c WHERE c.kind = @kind AND c.tag = @tag ORDER BY c.personId", parameters: [{ name: "@kind", value: USER_TAG_KIND }, { name: "@tag", value: tag }, { name: "@limit", value: limit }] };
      const { resources } = await container.items.query<Doc>(query).fetchAll();
      return resources.map((doc) => ({ doc, etag: String(doc._etag ?? "") }));
    },
    async readSaved() {
      const found = await readItem(USER_TAG_CATALOG_ID);
      return found && Array.isArray(found.doc.tags) ? { tags: (found.doc.tags as unknown[]).filter(isUserTag), etag: found.etag } : null;
    },
    async writeSaved(tags, etag) {
      const id = USER_TAG_CATALOG_ID;
      const doc = { id, scopeId: id, kind: "userTagCatalog", schemaVersion: 1, tags };
      try {
        const r = etag ? await container.item(id, id).replace(doc, { accessCondition: { type: "IfMatch", condition: etag } }) : await container.items.create(doc);
        return r.etag ?? null;
      } catch (err) { if ([404, 409, 412].includes(statusOf(err))) return null; throw err; }
    },
  };
}

export function createMemoryUserTagStore(): UserTagStore & { docs: Map<string, { doc: Doc; etag: string }>; saved: { tags: string[]; etag: string } | null } {
  let n = 0;
  const next = () => `"tag-${++n}"`;
  const store = {
    settings: null as { label: string; etag: string } | null,
    async readSettings() { return store.settings ? structuredClone(store.settings) : null; },
    async writeSettings(doc: Doc, etag: string | null) {
      if ((store.settings?.etag ?? null) !== etag) return null;
      store.settings = { label: String(doc.label), etag: next() };
      return store.settings.etag;
    },
    docs: new Map<string, { doc: Doc; etag: string }>(),
    saved: null as { tags: string[]; etag: string } | null,
    async read(personId: string) { const d = store.docs.get(userTagDocumentId(personId)); return d ? structuredClone(d) : null; },
    async create(doc: Doc) {
      if (store.docs.has(String(doc.id))) return "conflict" as const;
      const etag = next(); store.docs.set(String(doc.id), { doc: structuredClone(doc), etag }); return etag;
    },
    async replace(doc: Doc, etag: string) {
      const cur = store.docs.get(String(doc.id));
      if (!cur || cur.etag !== etag) return "precondition_failed" as const;
      const e = next(); store.docs.set(String(doc.id), { doc: structuredClone(doc), etag: e }); return e;
    },
    async list(tag: string | null, limit: number) {
      return [...store.docs.values()].filter((d) => tag === null || d.doc.tag === tag)
        .sort((a, b) => String(a.doc.personId).localeCompare(String(b.doc.personId))).slice(0, limit).map((d) => structuredClone(d));
    },
    async readSaved() { return store.saved ? structuredClone(store.saved) : null; },
    async writeSaved(tags: string[], etag: string | null) {
      if ((store.saved?.etag ?? null) !== etag) return null;
      store.saved = { tags: [...tags], etag: next() }; return store.saved.etag;
    },
  };
  return store;
}
