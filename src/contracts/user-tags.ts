// Individual user tags (owner decision 2026-10-23, UNKNOWNS G-A2). An admin tags a person with a
// chargeback ID (for example a WBS element) when onboarding them; saved tags are suggested while
// typing. The sync copies a person's tag into their group memberships as `chargebackId`, so the
// gateway stamps every request with it. Documents live in the admin's `adminConfig` container
// (partition key /scopeId = id): one per person, plus one list of saved tags.

import { CHARGEBACK_ID } from "./group-registration.ts";

export const USER_TAG_KIND = "userTag";
export const USER_TAG_CATALOG_ID = "userTagCatalog";
export const MAX_SAVED_TAGS = 2000;
export const MAX_SUGGESTIONS = 20;
export const USER_TAG_SETTINGS_ID = "userTagSettings";
export const DEFAULT_USER_TAG_LABEL = "User tag";

export const isUserTagLabel = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 64 &&
  value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !/^[=+\-@]/.test(value);

// Display headings only: callers must still look up values with the original machine keys.
export function userTagHeaders(columns: readonly string[], label: string): string[] {
  if (!isUserTagLabel(label)) throw new Error("user_tag_label_invalid");
  const tagged = (key: string) => key === "chargebackId" || key === "userTag";
  const used = new Set(columns.filter((key) => !tagged(key)).map((key) => key.toLowerCase()));
  return columns.map((key) => {
    if (!tagged(key)) return key;
    let heading = label;
    if (used.has(heading.toLowerCase())) heading = `${label} (${key})`;
    const base = heading;
    for (let n = 2; used.has(heading.toLowerCase()); n++) heading = `${base} ${n}`;
    used.add(heading.toLowerCase());
    return heading;
  });
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The same pattern as the chargeback ID: inert in a CSV cell, a KQL literal and a URL query value.
export const isUserTag = (value: unknown): value is string => typeof value === "string" && CHARGEBACK_ID.test(value);
export const isPersonId = (value: unknown): value is string => typeof value === "string" && GUID.test(value);

export const userTagDocumentId = (personId: string): string => `${USER_TAG_KIND}-${personId.toLowerCase()}`;

// A stored tag document, or null when it is not one (wrong kind, id not derived from the person,
// invalid person or tag). `tag: null` means the tag was cleared.
export function readUserTagDocument(doc: unknown): { personId: string; tag: string | null } | null {
  if (!isObject(doc) || doc.kind !== USER_TAG_KIND || !isPersonId(doc.personId)) return null;
  const personId = doc.personId.toLowerCase();
  if (doc.id !== userTagDocumentId(personId)) return null;
  if (doc.tag !== null && !isUserTag(doc.tag)) return null;
  return { personId, tag: doc.tag };
}

// Person ID to tag from the stored documents. Invalid documents and cleared tags are skipped; more than
// `max` documents is refused, so a runaway container cannot stall the sync (the run keeps stored IDs).
export const MAX_TAGGED_PEOPLE = 200_000;
export function userTagMap(docs: readonly unknown[], max = MAX_TAGGED_PEOPLE): Map<string, string> {
  if (docs.length > max) throw new Error("user_tags_too_many");
  const map = new Map<string, string>();
  for (const doc of docs) {
    const read = readUserTagDocument(doc);
    if (read && read.tag !== null) map.set(read.personId, read.tag);
  }
  return map;
}

// Reads tag documents page by page (a Cosmos query iterator's fetchNext) and stops as soon as more than
// `max` have arrived, so an oversized container costs at most one page beyond the limit.
export async function readUserTagPages(
  nextPage: () => Promise<{ resources: readonly unknown[]; hasMore: boolean }>, max = MAX_TAGGED_PEOPLE,
): Promise<Map<string, string>> {
  const docs: unknown[] = [];
  for (;;) {
    const page = await nextPage();
    docs.push(...page.resources);
    if (docs.length > max) throw new Error("user_tags_too_many");
    if (!page.hasMore) return userTagMap(docs, max);
  }
}

// Saved tags matching the typed text, case-insensitive: prefix matches first, then other matches,
// each alphabetical (case-insensitive), at most `limit`.
export function suggestTags(saved: readonly string[], text: string, limit = MAX_SUGGESTIONS): string[] {
  const needle = text.trim().toLowerCase();
  const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
  const matches = saved.filter((t) => t.toLowerCase().includes(needle));
  const prefix = matches.filter((t) => t.toLowerCase().startsWith(needle)).sort(byName);
  const other = matches.filter((t) => !t.toLowerCase().startsWith(needle)).sort(byName);
  return [...prefix, ...other].slice(0, limit);
}

// The saved list with `tag` added once (exact match), sorted. Refuses an invalid tag, and a new tag
// once the list holds MAX_SAVED_TAGS.
export function mergeSavedTags(saved: readonly string[], tag: string): string[] {
  if (!isUserTag(tag)) throw new Error("user_tag_invalid");
  if (saved.includes(tag)) return [...saved];
  if (saved.length >= MAX_SAVED_TAGS) throw new Error("saved_tags_full");
  return [...saved, tag].sort((a, b) => a.localeCompare(b));
}
