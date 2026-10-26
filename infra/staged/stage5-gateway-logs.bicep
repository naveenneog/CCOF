// Stage 5 helper, existing API Management only (ADR-0045): the resource-log diagnostic setting that Stage 1 creates
// for a CCOF-created instance (apim-service.bicep), so the gateway's logs reach CCOF's workspace.
targetScope = 'resourceGroup'

param apimName string
param settingName string = 'ccof-gateway-logs'
param workspaceId string

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource gatewayLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: settingName
  scope: apim
  properties: {
    workspaceId: workspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      { category: 'GatewayLogs', enabled: true }
      { category: 'GatewayLlmLogs', enabled: true }
    ]
  }
}

output id string = gatewayLogs.id
