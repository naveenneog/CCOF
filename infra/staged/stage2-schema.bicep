// Stage 2: Cosmos database and container structure only. No documents, no data-role definitions or
// assignments (Stage 3) and no settings. The container list matches the quickstart's
// (infra/quickstart/modules/cosmos-data.bicep, cosmosContainers); tests/Test-StagedStages.ps1 compares
// them. adminConfig is the admin catalog container (infra/admin/admin-v2-catalog.bicep), only with
// includeAdmin. chargebackDaily is the chargeback history container (ADR-0044), only with
// audit.chargebackHistory.enabled; it is not in the quickstart.
targetScope = 'resourceGroup'

@description('Stage 1 output `names`.')
param names object

@minLength(1)
param databaseName string

@allowed(['serverless', 'provisioned-autoscale'])
param capacityMode string = 'serverless'

@minValue(1000)
param autoscaleMaxThroughput int = 1000

param includeAdmin bool = true

@description('audit.chargebackHistory (ADR-0044): enabled and ttlDays (null: no expiry). Empty: no history container.')
param chargebackHistory object = {}

var cosmosContainers = [
  { name: 'entitlement', partitionKey: '/personId' }
  { name: 'projects', partitionKey: '/projectId' }
  { name: 'subscriptionIndex', partitionKey: '/subscriptionId' }
  { name: 'budgetState', partitionKey: '/personId' }
  { name: 'aggregateBudgetState', partitionKey: '/scopeId' }
  { name: 'syncLease', partitionKey: '/id' }
  { name: 'reconcilerLease', partitionKey: '/id' }
  { name: 'backends', partitionKey: '/backendId' }
]
var adminContainers = includeAdmin ? [{ name: 'adminConfig', partitionKey: '/scopeId' }] : []
var historyEnabled = chargebackHistory.?enabled ?? false
var historyTtlDays = chargebackHistory.?ttlDays
var historyContainers = historyEnabled ? [{ name: 'chargebackDaily', partitionKey: '/month' }] : []
var allContainers = concat(cosmosContainers, adminContainers, historyContainers)
// Only the fields the reconciler and the export query are indexed: fewer RU per write (UNKNOWNS AUD-C1).
var historyResource = union({
  indexingPolicy: {
    indexingMode: 'consistent'
    automatic: true
    includedPaths: [{ path: '/day/?' }, { path: '/chargebackId/?' }, { path: '/projectId/?' }, { path: '/classification/?' }, { path: '/personId/?' }, { path: '/model/?' }]
    excludedPaths: [{ path: '/*' }]
  }
}, historyTtlDays == null ? {} : { defaultTtl: historyTtlDays * 86400 })

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: names.cosmosAccount
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: { id: databaseName }
    options: capacityMode == 'provisioned-autoscale' ? { autoscaleSettings: { maxThroughput: autoscaleMaxThroughput } } : {}
  }
}

@batchSize(1)
resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [for c in allContainers: {
  parent: database
  name: c.name
  properties: {
    resource: union({
      id: c.name
      partitionKey: { paths: [c.partitionKey], kind: 'Hash' }
    }, c.name == 'chargebackDaily' ? historyResource : {})
  }
}]

output databaseName string = database.name
output containers array = [for c in allContainers: { name: c.name, partitionKey: c.partitionKey }]
