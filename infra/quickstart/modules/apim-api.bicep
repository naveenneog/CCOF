// Quick-start (ADR-0024, Proposed): the gateway's API in an EXISTING API Management instance, as
// D2's apim step makes it (scripts/Core.D2Apim.psm1, Invoke-CoreD2Apim): the API, its one
// operation, one backend entity per Foundry backend, and the API policy. The service resource is
// only referenced (`existing`): this module never redeploys or changes it, so the system-assigned
// identity stays (`az apim update` would strip it; Core.D2Apim.psm1 header).
// Managed-identity backends need no named value: the rendered policy takes a token for the
// descriptor's resource (https://cognitiveservices.azure.com) with authentication-managed-identity
// (infra/gateway/assignments.json, gw-apim-foundry-user "why"); render.ts allows no named value
// other than second-tenant backend secrets (infra/gateway/render.ts header).

targetScope = 'resourceGroup'

param apimName string
param apiId string
param apiPath string
param apiDisplayName string

@description('[{ id, url }] for each Foundry backend; url ends with /anthropic.')
param backends array

@description('The policy rendered by infra/gateway/render.ts, or empty: then the API answers 503 until it is rendered (Core.D2Apim.psm1 InitialPolicy).')
param policyXml string

@description('The GET /ccof/me/usage operation policy rendered by infra/gateway/render.ts (<apiId>.usage.policy.xml), or empty: then the operation is not created (docs/USAGE.md).')
param usagePolicyXml string = ''

@description('[{ id, xml }] policy fragments that policyXml includes (<apiId>.policy.deployment.json from infra/gateway/render.ts). API Management refuses an API policy over 16 KB, so the rendered policy is deployed as one fragment per section (ADR-0039). Empty when policyXml is self-contained.')
param policyFragments array = []

// scripts/Core.D2Apim.psm1 $script:InitialPolicy: the gateway never serves unchecked.
var initialPolicy = '<policies><inbound><return-response><set-status code="503" reason="Service Unavailable" /><set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header><set-body>{"type":"error","error":{"type":"api_error","message":"The gateway is not configured yet."}}</set-body></return-response></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: apiId
  properties: {
    displayName: apiDisplayName
    path: apiPath
    protocols: ['https']
    subscriptionRequired: false
  }
}

resource operation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'create-message'
  properties: {
    displayName: 'Create message'
    method: 'POST'
    urlTemplate: '/v1/messages'
    templateParameters: []
    responses: []
  }
}

var memberSets = [for b in backends: (contains(b, 'failover') ? [
  { id: '${b.id}-primary', url: b.url, circuitBreaker: b.circuitBreaker }
  { id: b.failover.id, url: b.failover.url, circuitBreaker: b.circuitBreaker }
] : [b])]
var singles = flatten(memberSets)

resource apimBackends 'Microsoft.ApiManagement/service/backends@2024-05-01' = [for b in singles: {
  parent: apim
  name: b.id
  properties: union({
    url: b.url
    protocol: 'http'
    tls: { validateCertificateChain: true, validateCertificateName: true }
  }, contains(b, 'circuitBreaker') ? { circuitBreaker: b.circuitBreaker } : {})
}]

resource pools 'Microsoft.ApiManagement/service/backends@2024-05-01' = [for b in backends: if (contains(b, 'failover')) {
  parent: apim
  name: b.id
  properties: {
    type: 'Pool'
    pool: {
      services: [
        { id: resourceId('Microsoft.ApiManagement/service/backends', apimName, '${b.id}-primary'), priority: 1, weight: 1 }
        { id: resourceId('Microsoft.ApiManagement/service/backends', apimName, b.failover.id), priority: 2, weight: 1 }
      ]
    }
  }
  dependsOn: [apimBackends]
}]

resource fragments 'Microsoft.ApiManagement/service/policyFragments@2024-05-01' = [for f in policyFragments: {
  parent: apim
  name: f.id
  properties: {
    format: 'rawxml'
    value: f.xml
    description: 'CCOF gateway policy section, rendered by infra/gateway/render.ts (ADR-0039).'
  }
}]

resource policy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: empty(policyXml) ? initialPolicy : policyXml
  }
  dependsOn: [operation, apimBackends, pools, fragments]
}

// The caller's own budget figures. Its operation policy has no <base />, so the API policy above does
// not run for it (infra/gateway/policy/my-usage.template.xml).
resource usageOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (!empty(usagePolicyXml)) {
  parent: api
  name: 'get-my-usage'
  properties: {
    displayName: 'Get my usage'
    method: 'GET'
    urlTemplate: '/ccof/me/usage'
    templateParameters: []
    responses: []
  }
}

resource usagePolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = if (!empty(usagePolicyXml)) {
  parent: usageOperation
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: usagePolicyXml
  }
}

output apiResourceId string = api.id
output gatewayUrl string = apim.properties.gatewayUrl
output principalId string = apim.identity.principalId
