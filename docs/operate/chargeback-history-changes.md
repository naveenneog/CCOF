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
