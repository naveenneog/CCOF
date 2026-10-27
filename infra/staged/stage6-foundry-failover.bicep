targetScope = 'resourceGroup'
param name string
param location string
param tags object
param accountId string
param subnetId string
param zoneIds array
param createZones bool = false
param vnetId string = ''

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for id in zoneIds: if (createZones) {
  name: last(split(id, '/'))
  location: 'global'
}]
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (id, i) in zoneIds: if (createZones) {
  parent: zones[i]
  name: 'ccof-foundry-failover'
  location: 'global'
  properties: { virtualNetwork: { id: vnetId }, registrationEnabled: false }
}]

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      { name: 'account', properties: { privateLinkServiceId: accountId, groupIds: ['account'] } }
    ]
  }
}
resource group 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for (id, i) in zoneIds: { name: 'foundry-${i}', properties: { privateDnsZoneId: id } }]
  }
  dependsOn: [zones, links]
}
output id string = endpoint.id
