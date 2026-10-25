# Chargeback history: changing the expiry and deleting history

For [chargeback history](chargeback-history.md) in an existing deployment.

## Changing ttlDays between null and a number

Stage 2 stops with `chargeback_history_ttl_transition` when `chargebackDaily` exists and `ttlDays` changes from
`null` to a number, or from a number to `null` ([Staged.Cosmos.ps1](../../infra/staged/Staged.Cosmos.ps1)
`Get-StgChargebackTtlTransitionProblem`, [ADR-0044 decision 10](../adr/0044-chargeback-history-in-cosmos.md)).
Either change would make the coverage records wrong for months already written:

- `null` to a number: documents were written with no expiry and their months are recorded as never expiring. A new
  container time to live applies at once to those documents, from their last write
  ([time to live](https://learn.microsoft.com/en-us/azure/cosmos-db/time-to-live)), so the export could return a
  month as covered after some of its documents were deleted.
- A number to `null`: without a container time to live, Cosmos DB ignores each document's own `ttl` and deletes
  nothing, while the coverage records still give each month an expiry, so the export would refuse months that are
  still there.

What to do instead:

- To keep history longer, raise `ttlDays`, up to 24855 days (about 68 years), and preview and apply Stages 2, 3 and
  5. Months already written keep the expiry they were written with.
- To switch between `null` and a number, start the history again: export the months you need first, then delete
  the container. This is an Azure Resource Manager call, so Cosmos DB public network access does not apply; it
  needs `Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/delete`, for example the DocumentDB Account
  Contributor role:

  ```powershell
  az cosmosdb sql container delete --resource-group <resource group> --account-name <Cosmos account> --database-name <database> --name chargebackDaily
  ```

  Then change `ttlDays` and preview and apply Stages 2 (creates the container with the new time to live), 3 and 5.
  History starts again from the reconciler's next run; earlier months are refused with `history_not_covered`.

## Delete history

[delete-chargeback-history.ts](../../scripts/history/delete-chargeback-history.ts) deletes the documents of whole
months, or of one person in those months, for example to answer a deletion request or to keep less than `ttlDays`.
It only counts (what-if) unless `--confirm` is given:

```powershell
node scripts/history/delete-chargeback-history.ts --endpoint https://<Cosmos account>.documents.azure.com:443/ --database <database> --month 2025-01 [--month 2025-02] [--person <personId>] [--confirm]
```

It prints one `ccof.history.delete.v1` line per month with `documents` (found), `deleted` and `coverage`:

- A whole month: the month's coverage record is deleted first, then its documents (`coverage: deleted`). The export
  then refuses the month with `history_not_covered`; if the run stops half-way, the month is refused, never shown as
  covered with documents missing. Rerun the same command to finish.
- One person (`--person`, the `personId` in the documents, which is the person's Microsoft Entra object ID): the
  coverage record first notes the deletion in `personDeletions` (time and document count, not the ID), then that
  person's documents are deleted (`coverage: noted`). The month stays covered; its totals no longer include that
  person.
- The previous month and later are refused (`history_month_too_recent`): the reconciler may still write them and
  would write the deleted days again from Log Analytics while the workspace keeps them. Delete those months later,
  and note that Log Analytics keeps the request rows until its own retention ends.
- The coverage record is changed only if no one changed it since it was read (If-Match); otherwise the tool stops
  before deleting any document of that month.

**Who and from where.** The Stage 3 roles cannot delete (the reconciler's writer role has no delete action, by
design). The person running the tool needs the Cosmos DB Built-in Data Contributor role
(`00000000-0000-0000-0000-000000000002`) on the container, assigned for the task by whoever may assign Cosmos DB
data-plane roles (the Stage 3 access administrator), and removed afterwards
([data-plane role-based access](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access)):

```powershell
az cosmosdb sql role assignment create --resource-group <resource group> --account-name <Cosmos account> --role-definition-id 00000000-0000-0000-0000-000000000002 --principal-id <your object ID> --scope /dbs/<database>/colls/chargebackDaily
```

The tool signs in with `DefaultAzureCredential` (for example `az login`); the account accepts no keys. Cosmos DB
public network access is disabled, so run it from a machine that reaches the account's private endpoint and resolves
`privatelink.documents.azure.com`, such as a VM in the deployment's virtual network, with Node.js 22 and `npm ci`
run in the checkout. Remove the assignment afterwards with `az cosmosdb sql role assignment delete
--role-assignment-id <id>` (find it with `az cosmosdb sql role assignment list`).
