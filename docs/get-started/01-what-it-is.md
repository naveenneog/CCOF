# 1. What CCOF is

CCOF gives an organisation's developers Claude Code through **one Azure gateway with private backends**.
Access, models, limits and monthly dollar budgets are managed per **existing Entra security group**,
and every request is charged to a cost code for chargeback.

[![Architecture: Entra sign-in, API Management gateway, Function Apps, Cosmos DB, Foundry, private network](../diagrams/ccof-architecture-overview.svg)](../diagrams/ccof-architecture-overview.svg)

## What each part does

| Part | Azure resource | Job |
| --- | --- | --- |
| Gateway | API Management (Standard v2) | Checks the developer's Entra token, applies limits, forwards to Foundry, records usage |
| Resolver | Function App | Tells the gateway which group applies to the caller and what is allowed; only the gateway can call it |
| Sync | Function App | Reads the members of each onboarded Entra group |
| Reconciler | Function App (every minute) | Prices usage and keeps each person's spent and remaining budget up to date |
| Admin console | Function App | Onboard groups, set budgets and models, tag people, chargeback reports |
| Registry | Cosmos DB | Groups, members, budget state, audit records |
| Telemetry | Log Analytics, Application Insights | The usage ledger and the chargeback workbook |
| Models | Microsoft Foundry | The Claude deployments |

Foundry, Cosmos DB and storage use private endpoints in the configured network. The gateway is the developer
entry point; the Entra-protected admin console has its own endpoint. Function App inbound access depends on
the deployment's networking settings ([network reference](../NETWORK.md)). Service-to-service authentication uses
managed identities, not stored API keys.

## How one request is handled

1. The developer signs in once; the CCOF helper gives Claude Code a token for the gateway.
2. The gateway checks the token and asks the resolver about the caller (by Entra object ID only).
3. The resolver picks the caller's group (the one named in the request, or the one with the higher spend this
   month) and returns the allowed models, limits and remaining budget.
4. The gateway applies the limits, forwards the request to Foundry, and records tokens and cost codes.
5. With a one-minute schedule, the reconciler prices new usage about every minute. The example guard warns and
   slows at 80% of projected spend and refuses at 100%. Recorded exhaustion lasts until the next month or a
   budget change; projected refusal can clear earlier. Reporting lag can still cause overshoot
   ([budgets](../operate/budgets-and-guard.md)).

## What a person sees

- Claude Code works as usual through the gateway.
- `/usage` in Claude Code shows the person's own spend, budget and any warning; an optional status line shows it
  continuously ([USAGE.md](../USAGE.md)).

Next: [prerequisites](02-prerequisites.md). Terms: [glossary](../GLOSSARY.md).
