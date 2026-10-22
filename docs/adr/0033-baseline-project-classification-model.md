# ADR 0033: Baseline record of the project/classification entitlement model

Status: accepted (record of existing behaviour), 2026-10-22. Superseded in part by ADR-0034.

This ADR records the model as of commit `66edaa7`, before the group-centric change, so that later
changes can be compared against a written baseline.

## Registration

- A `projects` document (`id == projectId`, pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`) holds
  `status` (`active`/`retired`), `backendId` and a `classifications` map
  ([src/sync/projects.ts:27-96](../../src/sync/projects.ts)).
- Each classification code (in practice `STD`, `PRM`, `CYB`) names one existing Entra group
  (`groupId`), a `familyPolicy`, `personBudget`, `aggregateBudget` (`null` = no cap) and
  `aggregateMode` (`strict`/`notify`) ([src/reconciler/registry.ts:56-89](../../src/reconciler/registry.ts)).
- The admin pastes group object IDs; the console does not search or create Entra groups
  ([docs/ADMIN-API.md](../ADMIN-API.md), [admin/src/validation.ts](../../admin/src/validation.ts)).
- Fable and Mythos families are accepted only under the classification code `CYB`
  ([src/contracts/model-families.ts:67](../../src/contracts/model-families.ts),
  [infra/gateway/policy/claude-messages.template.xml:140,309,472](../../infra/gateway/policy/claude-messages.template.xml)).

## Projection and selection

- The sync reads each registered group's direct members and writes one `entitlement` document per
  person, with one membership per project ([src/sync/plan.ts:173-205](../../src/sync/plan.ts)).
  A person in two classification groups of one project keeps the incumbent classification, else
  neither.
- The resolver selects a membership by subscription key, by the project selector header
  (`%%PROJECT_HEADER%%`, policy line 68), or, without a selector, the single active project. Two or
  more projects without a selector are refused with `project_selection_required`
  ([src/resolver/select-membership.ts:79-91](../../src/resolver/select-membership.ts)).

## Budgets and reporting

- Per-person `budgetState` and per-scope `aggregateBudgetState` (scope `"<projectId>:<classification>"`)
  are computed by the reconciler from the usage ledger and a rate card
  ([src/reconciler/documents.ts:11-47](../../src/reconciler/documents.ts)).
- The usage trace (`ccof.usage.v1`) carries person, project, classification and group, and no
  surface or chargeback identifier ([analytics/ledger.kql:87-109](../../analytics/ledger.kql)).
- Chargeback is a JSON API and a UI CSV export of Log Analytics query rows; there is no server CSV
  endpoint or Power BI export ([admin/src/chargeback.ts:18-28](../../admin/src/chargeback.ts)).
- No `surface`, chargeback ID, WBS or cost-centre field exists in the TypeScript model.
