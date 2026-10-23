# ADR-0037: One persisted display label for user tags

**Status:** Accepted

**Date:** 2026-10-23

**Packet:** G-LABEL

## Context

Administrators need a field name such as **WBS ID** when tagging individual users, filtering usage
and downloading chargeback reports. Existing tags, suggestions, request-time attribution and
Power BI integrations must not change. A label in a browser preference or environment variable
would not consistently cover other administrators and server-generated downloads.

## Decision

Persist one document in the existing `adminConfig` container, using the same partition convention
as other admin settings: `id = scopeId = kind = "userTagSettings"`, `schemaVersion = 1`,
`label` (string), and server-written `updatedAt` / `updatedBy`. Cosmos system properties are not
editable. No tag documents, catalog entries, memberships or historical usage are rewritten.

`GET /api/user-tags/settings` requires the existing admin reader role and returns `label`,
`exists`, and `etag` (also an HTTP `ETag` for a saved document). Only an absent document means
`{label: "User tag", exists: false, etag: null}`. An invalid schema, malformed document, missing
ETag or failed read is an error, never a default. Older deployments need no migration: they ignore
this new document and retain their old presentation; upgrading starts with the default if it is absent.

`PUT` uses the existing editor role, accepts exactly `{label}`, and requires `If-None-Match: *`
for the first save or a specific `If-Match` thereafter. Both an initial stale-client check and
Cosmos create-conflict / replace-ETag checks prevent lost updates. The field-level
`userTag.settings` change record is appended before writing; racing writes are `refused`, and
exceptional writes are `unconfirmed`. Failed persistence is never reported as success.

Labels contain 1–64 UTF-16 code units, with no leading/trailing whitespace, C0/C1 control
characters, or leading `=`, `+`, `-`, `@`. Unicode text, spaces and punctuation inside a label
are supported. The field is rendered as React text, never markup. Tag value validation remains
unchanged.

The console uses the label for the tagging field, current-value display, tag filter, tagged-people
column, chargeback filter, tag breakdown and developer/tag columns. It refuses these screens on
a failed settings read, rather than rendering stale/default labels. Browser downloads refresh
settings before exporting. Both browser chargeback CSV and server Usage CSV replace only the
display heading for `chargebackId` / `userTag`, while looking up values with the original keys.
JSON and Power BI `columns`, row keys and query parameters stay unchanged. Groups CSV retains
its group-configuration schema: its `chargebackId` is a group's default, not an individual field.

Heading collisions are resolved case-insensitively against all other columns: append the machine
key in parentheses, then a numeric suffix if needed. Both source tag columns remain present if a
report contains both. CSV cells retain spreadsheet-formula protection and proper quoting.

## Consequences

- One adminConfig document and two routes; existing managed-identity data roles already cover them.
- No resolver, gateway, budget, analytics query or sync changes are required.
- Missing settings use the documented default; outages/corruption block display-label-dependent
  reports. JSON exports do not depend on display settings availability.
- Resetting the name means explicitly saving `User tag`, not deleting tag data.
- The navigation destination remains **User tags**, making the configuration page discoverable
  even after the field is renamed.

## Validation and review

Focused contract/API/CSV/UI-helper tests cover validation, reader/editor permissions, audit-first
writes, stale versions, write races, corrupted/missing settings, provider failures, stable machine
keys, collisions and unchanged saved suggestions. Strict admin server/UI checks and the admin
production build pass. Seven temporary mutations were killed by named tests with all 36 tests
loaded before, during and after mutation; source files were restored.
The full packet gate passed (22 pass, 3 warning, 1 skip): root tests 402.0s, root strict
typecheck 3.9s, root build 23.5s. Warnings are shared-worktree size, existing oversized files
and parent-owned open unknowns; the undeclared lint command is skipped. All 166 admin tests pass.

Self-review (no delegated reviewers, per packet boundary): Architect PASS (existing store/partition);
Coder PASS (shared validation/header helper); QA PASS (negative and race tests plus mutations);
UX PASS-WITH-NOTES (labelled fields and explicit loading/error/retry; no browser E2E captured);
Security PASS (existing authentication/roles, ETags, inert React/CSV sinks and bounded input).
