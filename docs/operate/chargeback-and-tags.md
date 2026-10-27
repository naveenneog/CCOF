# Chargeback and user tags

Every request is charged to one cost code:

1. the person's **user tag**, when the admin has tagged them; otherwise
2. the onboarded group's **chargeback ID**.

## Name the field and tag people

Admin console → **User tags**:

1. **Tag field name** — one name for the deployment, for example **WBS ID**. It is used in the console, the filters and
   the CSV header. JSON and Power BI keys stay `chargebackId` and `userTag`.
2. **Tag a person** — choose an onboarded group's member (or paste an Object ID), type the value, **Save tag**.
   Values saved before are suggested as you type.

![Field name WBS ID, a tagged person and the tagged-people list](../evidence/2026-10-24-demo/console-06-user-tags.png)

A new tag reaches requests at the next sync (automatic mode) or snapshot (snapshot mode); requests before that keep
the group's chargeback ID.

## Reports

Admin console → **Chargeback**: filter by period, group, model, family, developer or the tag field; the breakdown
tabs are Groups, Developers, the tag field (for example **WBS ID**), Models, Families, Unpriced and
Diagnostics. **Export CSV** downloads the current tab with the field name as the column header.

Ranking and cost breakdowns are group-only. There is no project-tag filter,
classification drill-down or Groups/Projects toggle. Historical non-GUID scope IDs
remain visible as text, but do not link to a removed management page. Older
screenshots may still show controls that have been removed.

![Chargeback, Developers tab with the WBS ID column](../evidence/2026-10-24-demo/console-09-chargeback.png)

![The downloaded CSV: the WBS ID column per developer](../evidence/2026-10-24-demo/csv-chargeback-developers.png)

Costs are list price at the approved rate card (100 CCU = USD 1), less any recorded private-offer discount; they are
not an Azure invoice. Power BI and the workbook: [CHARGEBACK.md](../CHARGEBACK.md).

## History beyond Log Analytics retention

The reports, their **Export CSV** button and the workbook read the usage ledger in Log Analytics, so they cover only
the workspace retention: `audit.workspaceRetentionDays` if set, else `stage1.retentionInDays` (30 in the template).
For older months, turn on chargeback history: the reconciler keeps daily totals per tag value (the person's user
tag, or the group's chargeback ID), group, person and model in Cosmos DB, and the usage export API reads them. How
to turn it on, download an old month, check it and its cost: [chargeback history](chargeback-history.md).
