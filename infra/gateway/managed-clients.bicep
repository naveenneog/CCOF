// Experimental, explicitly deployed operation overlay; never changes the existing inference policy or settings.
targetScope = 'resourceGroup'
param apimName string
param apiId string
param operations array

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = { name: apimName }
resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' existing = { parent: apim, name: apiId }
resource discovery 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for operation in operations: {
  parent: api
  name: operation.name
  properties: {
    displayName: operation.name
    method: operation.method
    urlTemplate: operation.urlTemplate
    templateParameters: []
    responses: []
  }
}]
resource policies 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = [for (operation, i) in operations: {
  parent: discovery[i]
  name: 'policy'
  properties: { format: 'rawxml', value: operation.policyXml }
}]
