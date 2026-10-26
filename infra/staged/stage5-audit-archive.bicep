// Stage 5 helper: the long-term audit archive account (ADR-0043). Deployed in the deployment resource group at
// the API Management region (a diagnostic destination must be in the monitored resource's region).
// Azure Monitor writes through the trusted-services exception: public network access Enabled with default action
// Deny and no rule. A storage policy may set it to Disabled; Azure Monitor still delivers (docs/UNKNOWNS.md AUD-A2).
targetScope = 'resourceGroup'

@minLength(3)
@maxLength(24)
param accountName string
param location string
param tags object = {}
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_GZRS', 'Standard_RAGZRS'])
param storageSku string = 'Standard_LRS'
@description('Days after the last append before a log blob is deleted; null keeps blobs (the rule is disabled).')
param retentionDays int?
@description('Container-level time-based retention in days, unlocked; null leaves the containers without a policy.')
param immutabilityDays int?
// Staged.Audit.ps1 $script:AuditContainers holds the same two names.
var containers = ['insights-logs-gatewaylogs', 'insights-logs-gatewayllmlogs']
@description('Containers whose policy the owner has locked: Stage 5 never rewrites a locked policy.')
param lockedContainers array = []

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: storageSku }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}

// Azure Monitor creates insights-logs-<category> on first write; creating them here lets a policy exist first.
resource logContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in containers: {
  parent: blobService
  name: c
  properties: { publicAccess: 'None' }
}]

// The hourly PT1H.json blobs are append blobs: protected append writes keep them writable under the policy.
resource immutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = [for (c, i) in containers: if (immutabilityDays != null && !contains(lockedContainers, c)) {
  parent: logContainers[i]
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: immutabilityDays ?? 1
    allowProtectedAppendWrites: true
  }
}]

// Append blobs cannot be tiered to Cool or Archive (docs/UNKNOWNS.md AUD-A5): the rule only deletes.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'ccof-audit-retention'
          enabled: retentionDays != null
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['appendBlob']
              prefixMatch: ['insights-logs-gatewaylogs/', 'insights-logs-gatewayllmlogs/']
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: retentionDays ?? 36500 }
              }
            }
          }
        }
      ]
    }
  }
  dependsOn: [logContainers]
}

output id string = account.id
output name string = account.name
