// Stage 5 helper: the gateway's second resource-log diagnostic setting, to the audit archive account (ADR-0043).
// Stage 1's ccof-gateway-logs keeps the workspace destination; this setting has a storage destination only.
targetScope = 'resourceGroup'

param apimName string
param storageAccountId string

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource archive 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'ccof-gateway-archive'
  scope: apim
  properties: {
    storageAccountId: storageAccountId
    logs: [
      { category: 'GatewayLogs', enabled: true }
      { category: 'GatewayLlmLogs', enabled: true }
    ]
  }
}

output id string = archive.id
