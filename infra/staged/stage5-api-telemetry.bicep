// Stage 5 helper: the API-level Azure Monitor logger and diagnostic (LLM token logging) of
// infra/poc/phase4-apim-telemetry.bicep, without its resource-log diagnostic setting (Stage 1 owns it, or for an existing
// instance stage5-gateway-logs.bicep). An existing instance's azuremonitor logger is referenced, not rewritten (ADR-0045).
targetScope = 'resourceGroup'

param apimName string
param apiId string
@description('True when the instance already has an azuremonitor logger that CCOF did not create (an existing instance).')
param reuseLogger bool = false

resource apim 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  name: apimName
}

resource api 'Microsoft.ApiManagement/service/apis@2024-06-01-preview' existing = {
  parent: apim
  name: apiId
}

resource monitorLogger 'Microsoft.ApiManagement/service/loggers@2024-06-01-preview' = if (!reuseLogger) {
  parent: apim
  name: 'azuremonitor'
  properties: {
    loggerType: 'azureMonitor'
    description: 'ccof-wp=tel; keyless Azure Monitor resource logs'
    isBuffered: true
  }
}

resource apiDiagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-06-01-preview' = {
  parent: api
  name: 'azuremonitor'
  properties: {
    loggerId: resourceId('Microsoft.ApiManagement/service/loggers', apimName, 'azuremonitor')
    alwaysLog: 'allErrors'
    sampling: { samplingType: 'fixed', percentage: 100 }
    verbosity: 'information'
    logClientIp: false
    frontend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: [] }
    }
    backend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: [] }
    }
    largeLanguageModel: { logs: 'enabled' }
  }
  dependsOn: [monitorLogger]
}

output diagnosticId string = apiDiagnostic.id
