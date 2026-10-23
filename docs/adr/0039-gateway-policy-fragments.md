# ADR-0039: Gateway policy deployed as policy fragments

Status: Accepted (2026-10-24).

## Context

Stage 5 of a new staged deployment failed on a Standard v2 API Management instance that ARM reports as created
on 2026-10-23: `ValidationError`, target `representation`, "Policy size exceeds allowed limit of 16 KB", for the
API policy of `claude-messages` (90,423 characters). Direct ARM `PUT` probes on the same instance gave:

| Policy sent | Result |
| --- | --- |
| The rendered API policy without comments | Refused, 16 KB |
| The rendered API policy with its largest expression replaced by `@("x")` | Refused, 16 KB |
| The 84,089-character policy another lab's Standard v2 instance (created 2026-10-20) serves | Refused, 16 KB |
| A 20,182-character policy with one expression; 31,654 characters in thirty expressions | Both refused, 16 KB |
| Policy fragments of 12,000, 20,000, 60,000 characters and the real 67,749-character `inbound` section | Accepted |
| An API policy under 16 KB that includes a 60,000-character fragment | Accepted |

The limit therefore applies to the API policy document on this instance, not to a single expression, and not
to policy fragments. Microsoft Learn's
[service limits](https://learn.microsoft.com/en-us/azure/api-management/service-limits) page (updated
2026-08-22) does not list a policy document size, so the measured behaviour above is the evidence. The other
lab's older instance still serves its larger policy.

## Options

1. Shrink the policy below 16 KB. The policy carries the token checks, resolver call, caches, limits and
   usage trace; 16 KB would remove required behaviour.
2. Move logic into named values. Named values hold strings, not policy elements.
3. Deploy the same policy as one fragment per section, with a small API policy that includes them (chosen).

## Decision

- `infra/gateway/render.ts` still renders the whole policy (`<apiId>.policy.xml`; its SHA-256 is the
  approved digest) and also writes `<apiId>.policy.deployment.json`: an API policy that keeps each section's
  leading `<base />` and includes one fragment per section, and the fragments. Putting each fragment's content
  back in place of its `<include-fragment>` gives the rendered policy byte for byte
  ([test](../../tests/gateway-policy-fragments.test.ts)).
- Fragment IDs end with 12 hex characters of the fragment's SHA-256, so a changed section is a new fragment.
  The live API policy (or an API revision) keeps the fragments it includes until it is replaced.
- `infra/quickstart/modules/apim-api.bicep` deploys the fragments before the API policy; the staged, quickstart
  and manual paths pass the split. The Core path (`GatewayDeploy.psm1`) saves the fragments before the new
  revision's policy ([test](../../tests/Test-GatewayRevisionFragments.ps1)).

## Consequences

- Earlier fragments stay in the API Management instance after a configuration change (one set per rendered
  policy). Policy fragments are not listed among the limited resources on the service limits page. Removal is roadmap item G-FRAG.
- A reviewer reads the whole policy in `<apiId>.policy.xml`; the Portal's API policy view shows the includes.
- Stage 5 live on the new instance: fragments and API policy deployed, the stage verified (2026-10-24).
