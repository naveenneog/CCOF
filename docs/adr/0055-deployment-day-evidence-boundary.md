# ADR-0055: deployment-day evidence and client support claims

Status: accepted, 2026-10-27. Packet: G-DAY.

## Context

The deployment-day material must distinguish one-identity routing/accounting proof from three-developer
acceptance and 25,000-developer capacity. It must also describe client onboarding without treating a selectable
group surface as a deployed integration. The console's Cowork note says it runs on Anthropic's servers and is
not routed through this gateway. Current vendor documentation also describes local Cowork execution and
Desktop gateway configuration. Repeating that console text as a universal technical claim would contradict
the researched sources.

## Decision

- Keep live measurements and unmodified source outputs privately; commit only pseudonymised excerpts/images.
  Terminal captures use the repository renderer and checked pseudonym mapping; browser captures check every
  displayed value before writing. State source run/date, measured timing versus planning allowance, and
  substitutions such as Azure CLI authentication in place of interactive console sign-in.
- Describe Cowork as outside this CCOF installer/live acceptance, quote the current console limitation as such,
  and separately cite the vendor's current capabilities. Do not infer native Office/Intune/Desktop proof.
- Document Office add-in third-party gateway support as vendor capability only. CCOF requires a verified token
  audience, admitted client, surface map, membership/model authorization, and usage attribution. Foundry-direct
  bypasses this gateway. An allowed group surface is neither client installation nor authentication.
- Publish Intune as an unverified pilot recipe derived from vendor managed-settings documentation and the actual
  CCOF-generated keys. Install dependencies/helpers per device and configure/sign in each user in their own
  context; never distribute token caches. Do not silently change existing client architecture.
- An explicit `acceptance.expectedGroup` Object ID is an attribution assertion, not a seed/route/access grant.
  Accept a console-onboarded group absent from the original Stage 4 inputs, then require this run's real usage
  traces to match it. Do not force a group reseed or app-registration changes for a read-only acceptance check.
  Match the actual `group` scope and charged Entra group ID as well as `projectId`; a GUID-shaped legacy
  project ID is not proof of group attribution.

## Sources checked 2026-10-27

- https://claude.com/docs/cowork/overview — local-computer work.
- https://claude.com/docs/third-party/claude-desktop/configuration — gateway/Cowork managed configuration.
- https://claude.com/docs/office-agents/third-party-platforms — LLM gateway, Foundry direct, Entra configuration.
- https://code.claude.com/docs/en/managed-settings — supported policy paths, `/status`, policy precedence.
- https://github.com/anthropics/claude-code/tree/main/examples/mdm — vendor/community MDM templates.
- `scripts/client/ClaudeCodeGateway.ps1`, `docs/CLIENTS.md`, `docs/GATEWAY.md` — current implementation.

## Consequences

The deployment checklist may be complete while customer rollout remains blocked on quota/capacity/acceptance.
No claim of a successful Intune/Office/Cowork/native Desktop pilot or full-population load test is implied.
The stale general Cowork console wording is recorded for its owning packet; this docs packet does not edit UI.
