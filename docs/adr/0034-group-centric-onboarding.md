# ADR 0034: Group-centric onboarding

Status: proposed, 2026-10-22. Items marked ASSUMED wait for owner confirmation
([UNKNOWNS](../UNKNOWNS.md) G-A1 to G-A4).

## Context

ADR-0033 records the baseline: a project owns STD/PRM/CYB classifications, each mapped to one Entra
group. The owner's requirements (2026-10-22) replace this with onboarding of individual Entra groups:
"no need of having std prm and cyb identifiers consider each group as a separate entity". The
`projectId`/`classification` pair reaches about 700 references in 76 files, including the APIM
policy, the ledger KQL and the workbook, so a one-step rename cannot keep the suite green.

## Decision

1. **Unit of onboarding.** An onboarded group is one existing Entra security group, identified by its
   object ID. It has a display name, status (`active`/`retired`), backend, per-user budget, budget
   mode, family policy, allowed surfaces, priority, chargeback ID and cache profile
   ([src/contracts/group-registration.ts](../../src/contracts/group-registration.ts)).
2. **Budget mode.** `autoScale`: each member gets the per-user budget and the group has no cap
   (`aggregateBudget: null`, `aggregateMode: notify`). `cap`: each member gets the per-user budget
   and the group shares a fixed monthly cap (`aggregateMode: strict`).
3. **Restricted families.** Fable and Mythos require `restrictedFamiliesApproved: true` on the group.
   The approval travels as that explicit flag (`restrictedFamiliesAllowed`,
   [src/contracts/model-families.ts](../../src/contracts/model-families.ts)); it is never inferred
   from a code a document can choose. Baseline `CYB` keeps its meaning.
4. **Transitional storage and wire format.** A group document is stored in the existing `projects`
   container with `kind: "group"`; `id`, `groupId` and the partition key `projectId` are the same
   lower-case object ID, so Cosmos id uniqueness gives one document per group and a baseline project
   with the same GUID cannot coexist. Each read boundary (sync, reconciler) dispatches on `kind` and
   builds the baseline structures: `projectId = groupId` and the single scope code `group`. The code
   is the same for every group and reserved (baseline projects may not use it), so the budget scope
   `"<groupId>:group"` does not move when the group's settings change. A later packet (ROADMAP
   G-WIRE) renames the wire fields. Baseline project documents remain readable until then.
5. **Precedence (owner decision 2026-10-23, G-A1).** A selector header names the group. Without one,
   when every active membership is an onboarded group, the group where the person has the higher
   usage spend this month applies: the reconciler's `spentCcu` in the person's `budgetState` for that
   group ([src/reconciler/reconcile-person.ts](../../src/reconciler/reconcile-person.ts)), compared as an
   exact decimal, for the current UTC month (`period`). A group with no state, or a state for an earlier
   month, counts as no spend. Equal spend (including none, at the start of a month) falls back to the
   lower `priority` number. Still tied, a malformed priority, or any baseline project among the
   candidates is refused with `project_selection_required`; a malformed `spentCcu` is
   `budget_state_invalid`; a failed read fails the request
   ([src/resolver/select-membership.ts](../../src/resolver/select-membership.ts)). The resolver makes one
   point read per candidate group, in the person's partition. Spend is as fresh as the reconciler's
   last run, and APIM caches the no-selector decision per person for the allow TTL, so the chosen group
   can change during a month as spend changes. If the higher-spend group is exhausted, the request is
   refused (`budget_exhausted`), not moved to another group; a selector names another group.
6. **Surfaces.** Allowed surfaces are a subset of `chat`, `cowork`, `code`, `m365`, `design`.
   `design` is accepted and stored but has no Foundry path yet. The resolver returns the list with
   the decision; APIM maps the calling client app ID (`azp`/`appid`, policy lines 42-44) to a
   surface. With no mapping configured, surfaces are not enforced.
7. **Chargeback ID as a user tag (owner decision 2026-10-23, G-A2).** The chargeback ID (for example a
   WBS element) is an individual user tag, set per person when the person is onboarded
   ([src/contracts/user-tags.ts](../../src/contracts/user-tags.ts), admin `/api/user-tags`). New tags
   are saved and suggested. The sync copies the person's tag into each of their group memberships as
   `chargebackId`; a person without a tag gets the group's own optional chargeback ID (ASSUMED default).
   If the tags cannot be read, the stored ID is kept. The usage trace carries it, so usage rows keep
   the tag current at request time (ADR-0025 request-time attribution); reports filter by it and show
   it per developer.
8. **Cache profile.** Each group stores an expected cache-read share of input tokens, either
   suggested from its enabled surfaces or entered by the admin. It feeds the budget assistant and
   the export; it does not affect enforcement.
9. **Removal (owner decision 2026-10-23, G-A3).** Removing a group is retirement, as for a project
   (admin 3.2.0): `POST /api/groups/{id}/retire` with `If-Match` and the group ID repeated
   (`confirmGroupId`); the document becomes `status: "retired"` with `retiredAt`; later edits return
   `409 group_retired`; the change record is written first; the next sync removes every member's
   membership outside the removal limits, and the reconciler stops registering its scope. The Entra
   group is not changed ([admin/src/groups.ts](../../admin/src/groups.ts), [src/sync/plan.ts](../../src/sync/plan.ts)).

## Consequences

- No STD/PRM/CYB code is entered or shown for a group. The scope code `group` exists only on the wire
  until G-WIRE.
- The membership carries `restrictedFamiliesApproved`; the resolver and the APIM policy check it
  together with the scope code (G2b). Withdrawing approval takes effect after the gateway's allow
  TTL plus last-known-good grace, as for CYB today; the immediate path is a cache `keyVersion` bump.
- APIM receives `surfaces` and `chargebackId` but neither validates nor copies them until G4/G7,
  which must validate them in both the cached and fresh blocks before use.
- G4 requires `surfaces` on every `group` decision. Deployment order: the resolver (G2b or later)
  before the gateway policy, or every group request returns 503. Group decisions cached by an older
  policy lack `surfaces`, fail the cached check and are re-resolved once; those users have no
  last-known-good fallback until that re-resolve succeeds.
- Council review of the first draft (2026-10-22) found that a tier-based scope code
  (`standard`/`restricted`) moved the budget scope when approval changed, and that any baseline
  project could declare the `restricted` code. Both are removed by decisions 3 and 4.
- A person in several groups gets one membership per group; the reconciler's per-person budget is
  per group, as it was per project.
- Rolling back means deleting group documents; baseline documents are untouched.
- Precedence by spend (decision 5) needs only the resolver package: the reconciler already writes
  `spentCcu` and `period`. APIM can keep an earlier decision for the allow TTL plus the last-known-good
  grace; raising `gateway.keyVersion` at rollout drops those cached decisions at once.
- Only the staged configuration (`gateway.surfaceClients`) can turn surface enforcement on. The quickstart,
  Core and manual producers emit an empty `surfaceClients`, so surfaces are not enforced on those paths.
- The staged deployment onboards its pilot as a group entry (`kind: "group"`, G-SEED): Stage 7 seeds the group
  document through the sync app's `registrySeed` function, which checks it with `readGroupRegistration` and
  seeds active groups only. The quickstart's seed and client still take project/classification entries only.
