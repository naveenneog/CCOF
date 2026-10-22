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
   This replaces the `CYB` code as the carrier of that approval.
4. **Transitional storage and wire format.** A group document is stored in the existing `projects`
   container with `kind: "group"` and `id == groupId`. One adapter converts it, at each read
   boundary, to the baseline shape: `projectId = groupId`, one scope whose code is the access tier
   (`standard` or `restricted`). Sync, resolver, reconciler and APIM consume that shape unchanged.
   A later packet (ROADMAP G-WIRE) renames the wire fields. Baseline project documents remain
   readable until then, so deployed data does not break before migration.
5. **Precedence (ASSUMED, G-A1).** A selector header names the group. Without one, the active
   membership with the lowest `priority` number applies; equal lowest priorities are refused with
   `project_selection_required`, as today.
6. **Surfaces.** Allowed surfaces are a subset of `chat`, `cowork`, `code`, `m365`, `design`.
   `design` is accepted and stored but has no Foundry path yet. The resolver returns the list with
   the decision; APIM maps the calling client app ID (`azp`/`appid`, policy lines 42-44) to a
   surface. With no mapping configured, surfaces are not enforced.
7. **Chargeback ID (ASSUMED, G-A2).** One optional chargeback ID per group (for example a WBS
   element). It is copied into each membership and into the usage trace, so usage rows carry the
   ID current at request time (ADR-0025 request-time attribution).
8. **Cache profile.** Each group stores an expected cache-read share of input tokens, either
   suggested from its enabled surfaces or entered by the admin. It feeds the budget assistant and
   the export; it does not affect enforcement.
9. **Requirement 9 ("removal of the group as a requirement")** is not designed until the owner
   states which meaning applies (G-A3).

## Consequences

- No STD/PRM/CYB code is entered or shown for a group. The access tier code exists only on the wire
  until G-WIRE.
- The CYB rule gains a second accepted code (`restricted`) in TypeScript and in the APIM policy.
- A person in several groups gets one membership per group; the reconciler's per-person budget is
  per group, as it was per project.
- Rolling back means deleting group documents; baseline documents are untouched.
