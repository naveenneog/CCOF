// Pure helpers for user tags in the console (owner decision 2026-10-23). The server applies the same
// rules (src/contracts/user-tags.ts); checking here only avoids a round trip.
import { isUserTagLabel } from "../../../src/contracts/user-tags.ts";

export { isUserTagLabel };
export function loadedLabel(data: unknown, loading: boolean, error: unknown): string | null {
  if (loading || error || !data || typeof data !== "object" || !("label" in data) || !isUserTagLabel(data.label)) return null;
  return data.label;
}

export const USER_TAG = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const tagProblem = (text: string): string | null =>
  text === "" || USER_TAG.test(text) ? null : "Up to 64 letters, digits and . _ / -, starting with a letter or digit.";

export const personProblem = (text: string): string | null =>
  GUID.test(text) ? null : "The person's Entra object ID: a GUID such as 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b.";

// The suggestions request for the typed text, or null when the text can't be a tag (no request).
export function suggestPath(text: string): string | null {
  const t = text.trim();
  if (t !== "" && !/^[A-Za-z0-9._\/-]{1,64}$/.test(t)) return null;
  return `/api/user-tags?search=${encodeURIComponent(t)}`;
}

// The PUT that sets a person's tag: create when they have none yet, otherwise change with the ETag.
export function tagWrite(personId: string, tag: string, current: { etag: string | null } | null) {
  const body = { tag: tag === "" ? null : tag };
  const path = `/api/user-tags/people/${encodeURIComponent(personId.toLowerCase())}`;
  return current?.etag ? { path, body, ifMatch: current.etag } : { path, body, ifNoneMatch: "*" };
}

// The person's loaded tag, ready only when it was loaded for this same person and is not reloading, so a
// save never uses another person's version.
export function loadedTagFor(person: string, data: { personId?: unknown; exists?: unknown; tag?: unknown } | null, loading: boolean, etag: string | null) {
  const ready = !loading && data !== null && typeof data.personId === "string" && data.personId === person.toLowerCase();
  const exists = ready && data?.exists === true;
  return { ready, exists, tag: exists && typeof data?.tag === "string" ? data.tag : "", etag: exists ? etag : null };
}
