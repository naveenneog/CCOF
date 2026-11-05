# ADR-0056: stable managed bootstrap and authorized model discovery

Status: experimental, 2026-11-05. Packet: G-MANAGED-DISCOVERY.

## Context

CCOF exports a fixed client model list. New models or Desktop feature selections can therefore require
another client configuration. The user requested an isolated experiment with one Windows `.reg` trust
anchor and backend-only updates. This is not permission to change customer deployments or machine policy.

## Decision

- Implement the documented third-party Desktop bootstrap contract, not an imitation of the Claude apps
  gateway's SSO/session protocol. `forceLoginMethod: gateway` and `/managed/settings` are not usable merely
  because APIM speaks Anthropic Messages.
- The generated registry file contains a stable HTTPS bootstrap URL and public Entra OIDC settings.
  Tokens, model IDs and feature selections do not belong in that trust anchor.
- An opt-in private resolver route reuses the existing APIM-only platform gate, resolver membership
  selection, current budget checks and backend status. APIM validates the user's JWT and takes the
  person ID only from its `oid`; request-supplied person IDs are never forwarded.
- Bootstrap returns the vendor's flat v1 document with `external-idp` access-token authentication,
  exact authorized model IDs, the selected group header and explicit Desktop feature states.
  A separate `GET /v1/models` supplies Anthropic-format model discovery for clients that support it.
- The visible models are the intersection of the selected membership's family policy and the server's
  explicit deployed-model metadata for that membership's backend. There is no global union of other
  groups and no claim that a discovered model bypasses inference admission.
- Desktop's current schema is moving Chat/Cowork into `desktopHome`. Enable that shared home only when
  both surfaces are admitted and enabled server-side; otherwise disable both. Code-tab permission stays
  separate. Client feature visibility is not an independent authorization boundary: CCOF's surface
  identity is the admitted OAuth client, not a caller-supplied tab name.
- Do not use the installed-but-publicly-undocumented `inferenceGatewayManagedClaudeCode` flag.
  Standalone Code discovery is a separate capability, not remote policy delivery. Existing pinned
  models/nonessential-traffic settings may need a one-time migration and explicit operator approval.
- Return `Cache-Control: no-store`; errors never become empty successful catalogs. Preserve all existing
  inference/budget/chargeback behavior. Do not silently fall back to another group or backend.

## Validation and release boundary

Tests must add and remove a server model, toggle Desktop features, and leave the registry bytes unchanged.
They must exercise HTTP routing, authorization/refusal, unknown models, cross-group isolation and revoked
membership. Vendor JSON Schema validation is separate from tests of our own output shape.

The installed Desktop 4.29.0 supports the relevant bootstrap keys, but already has an HKLM bootstrap
policy. Do not override that policy or claim an HTTP harness proves native Desktop/Cowork execution.
Keep this branch unmerged until an authorized isolated client proves model refresh and a real Chat and
Cowork inference request after a server-only change.

## Sources

- https://claude.com/docs/third-party/claude-desktop/bootstrap
- https://claude.com/docs/third-party/claude-desktop/configuration-format
- https://claude.com/docs/third-party/claude-desktop/schemas/bootstrap-config-v1.schema.json
- https://code.claude.com/docs/en/llm-gateway-protocol
- https://code.claude.com/docs/en/managed-settings
- https://code.claude.com/docs/en/claude-apps-gateway
- `src/resolver/http-handler.ts`, `decide.ts`, `freshness.ts`, `backend.ts`;
  `infra/gateway/policy/my-usage.template.xml`; `scripts/client/ClaudeDesktopGateway.ps1`.
