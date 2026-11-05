# Managed client discovery experiment

Branch: `experiment/managed-client-discovery`. Not a released client installer.

## What is possible

One Windows policy file can point Claude Desktop at an authenticated bootstrap endpoint. That endpoint returns
the current model list and Desktop feature settings. Backend changes do not require another registry import.
Standalone Claude Code uses a different contract: opt-in `GET /v1/models` discovery, not Desktop bootstrap.

| Surface | One-time configuration | Backend-only change | Boundary |
| --- | --- | --- | --- |
| Desktop Chat/Cowork | `bootstrapUrl` and `bootstrapOidc` under `HKLM\SOFTWARE\Policies\Claude` | Authorized models and Desktop home settings | Most settings require app relaunch after a configuration check, not an instant live change |
| Standalone Code / VS Code | `Settings` JSON under `HKLM\SOFTWARE\Policies\ClaudeCode`, approved Azure CLI helper | Newly discovered model IDs | Remove old CCOF model pins once; existing IT model restrictions still apply |
| Desktop Code tab | Desktop provider/identity and enabled Code setting | Desktop configuration | Native acceptance is not established by a standalone Code test |

This is not the Claude apps gateway protocol. CCOF does not mint that product's session tokens or implement
its `/login` and `/managed/settings` handshake. Setting `forceLoginMethod: gateway` on a generic APIM proxy
would not add those protocols.

## Implemented

- `POST /api/me/client-config` on the private resolver is off unless `CCOF_MANAGED_CLIENT_CONFIG` is set.
  It uses the same APIM-only platform authentication, group selection, current budget and backend-status
  checks as inference resolution.
- The standalone APIM overlay adds `GET <base>/ccof/client/bootstrap` and `GET <base>/v1/models`.
  The original inference policy is unchanged. The new operation policies reuse its validated tenant,
  audience, scope, client and `oid` guards; only the token's `oid` becomes the private request's person ID.
- Models are the intersection of the selected group's current synced policy and explicitly deployed models
  for its selected backend. A different group's models, credentials and backend details are not returned.
- Bootstrap returns the documented flat-v1 Desktop schema, access-token Entra authentication, an explicit
  group selector and model list. Responses use `Cache-Control: no-store`; errors do not become empty catalogs.
- The generator emits UTF-16LE `.reg` files, a resolver setting and APIM operation parameters. It never imports
  a policy, installs a helper, changes an app registration or deploys to Azure.

The current vendor schema unifies Chat and Cowork into `desktopHome`. This experiment enables the shared home
only when **both** surfaces are allowed by the group and enabled in the server configuration; otherwise both
are off. Older tab flags are emitted consistently. Independently authorizing Chat and Cowork with one shared
OAuth client is not a security guarantee: the existing gateway maps an admitted client ID to a surface,
not an untrusted tab name. The usual inference model/surface/budget checks remain authoritative.

## Isolated lab prerequisites

- A separate approved test deployment and disposable client. Do not replace an existing IT-managed policy.
  Desktop and Code on the development machine already have HKLM policies; neither was overridden.
- The resolver package is built from this branch and published using the usual deployment process.
- The Gateway registration is a combined public client/resource app in public Azure, with v2 access tokens,
  the delegated gateway scope, and `http://localhost/callback` registered for the Desktop browser flow.
  Its client ID must already be admitted by APIM. Keep Azure CLI preauthorization for the Code helper.
  Existing `surfaceClients` mappings must admit the chosen client and the intended group surfaces.
- An approved CCOF Azure CLI token helper is installed for Code. Registry files do not install software.
- Claude Code v2.1.257 or later is required to combine discovery with nonessential traffic disabled.
  Desktop must support `external-idp`, the flat bootstrap contract and the keys returned by the server.
  A new model can still require a newer client for its compiled-in capabilities.

Bootstrap sign-in and inference sign-in are independent. Using the same Entra registration permits the normal
browser SSO experience but does not guarantee a single prompt. No client secret or refresh token is bundled.

## Generate and deploy to that lab

Copy `infra/gateway/managed-clients.example.json` and fill it using the lab's actual gateway configuration.
`deployments` is server-side model metadata: backend ID, exact deployment ID, label and creation time.
The generator checks that each deployment appears in the gateway's inference-geo map.

```powershell
node .\infra\gateway\managed-clients.ts `
  '<lab-generated-gateway-config.json>' '<lab-managed-clients.json>' '<output-directory>'
```

Output:

| File | Purpose |
| --- | --- |
| `desktop-bootstrap.reg` | Stable Desktop trust anchor; no models or feature toggles |
| `code-discovery.reg` | Code's opt-in discovery and existing-helper reference; no model allowlist |
| `resolver-settings.json` | Server-side model metadata and feature settings |
| `apim.parameters.json` | Two operation policies, deployed separately from existing inference |

After review, use an isolated Azure CLI profile and the lab subscription:

```powershell
az functionapp config appsettings set --resource-group '<lab-rg>' --name '<lab-resolver>' `
  --settings '@<output-directory>\resolver-settings.json' --output none
az deployment group create --resource-group '<lab-apim-rg>' `
  --template-file .\infra\gateway\managed-clients.bicep `
  --parameters '@<output-directory>\apim.parameters.json' --output none
```

These are explicit experimental operations, not additions to the staged driver. Stage 5 replaces app settings,
so rerunning it requires reapplying the experimental resolver setting. Do not run these commands against a
customer deployment. Removing the setting disables discovery without changing the inference path.

The device-management owner reviews/merges the generated registry values into the isolated device's policy.
`code-discovery.reg` replaces the whole `Settings` value: it is not a safe blind merge into an existing policy.
Do not delete or loosen an organizational model/security restriction.

For an existing CCOF test profile, remove only the old CCOF-owned model pins once: `availableModels`,
`enforceAvailableModels`, and the `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` environment entries.
Check both Claude Code user settings and VS Code's environment entries. Existing pinned managed policy must
be migrated by its owner. The new policy keeps `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and enables only
gateway model discovery. Opaque deployment IDs without `claude` or `anthropic` are ignored by Code discovery.

## Add a model or enable Desktop home later

1. Deploy the real Foundry model and make the existing CCOF gateway/backend configuration admit it.
2. Admit its exact deployment ID in the intended group's family policy; wait for sync. Restricted families
   still require their existing explicit approval.
3. Add that backend/model metadata to the server configuration, regenerate the bundle, and apply only
   `resolver-settings.json` (plus ordinary gateway changes needed for the real deployment).
4. For Chat/Cowork, set both server feature flags and both group surfaces. Code-tab permission is separate.
5. Relaunch Desktop when it requests configuration refresh; start a fresh Code session and select the new
   discovered model. The registry files remain byte-for-byte unchanged.

Old cached picker entries can remain during an outage. They never grant inference access: the existing
gateway still checks the exact requested model against the selected group's current cached decision.

## Evidence and remaining acceptance

- Unit and loopback HTTP tests exercise backend-only addition/removal and capability changes with unchanged
  registry hashes, unauthorized requests, other-group/backend isolation, revoked membership, missing models,
  disabled backend and exhausted budget.
- Actual rendered C# response guards are compiled and their results asserted. JWT guard ASTs equal the
  existing operation's guards; the standalone Bicep module compiles.
- Generated bootstrap JSON passes the live published vendor v1 JSON Schema. A bad refresh-interval mutation
  is rejected by that independent validator.
- `scripts/client/Test-ManagedClientDiscovery.ts` runs a real installed Code executable against a local stub
  using a disposable profile and fake credential. It refuses to run over existing Code managed policy.
  The dedicated experimental CI job uses a pinned native client on a disposable Linux runner instead.
- A loopback server and schema validation do **not** prove Entra, APIM runtime, Foundry, native Desktop Chat,
  Desktop Code or Cowork. Real Desktop sign-in, model refresh after a backend-only change, Chat and Cowork
  inference and correct group chargeback remain required on an authorized isolated client before merge.

## References (checked 2026-11-05)

- [Desktop bootstrap contract](https://claude.com/docs/third-party/claude-desktop/bootstrap)
- [Desktop Windows policy format](https://claude.com/docs/third-party/claude-desktop/configuration-format)
- [Published bootstrap v1 JSON Schema](https://claude.com/docs/third-party/claude-desktop/schemas/bootstrap-config-v1.schema.json)
- [Code model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)
- [Code managed settings and precedence](https://code.claude.com/docs/en/managed-settings)
- [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)
- [ADR-0056](../adr/0056-managed-client-discovery-experiment.md)
