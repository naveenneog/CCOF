# Current deployment unknowns

## Group-centric onboarding (ADR-0034)

| ID | State | Question / evidence |
| --- | --- | --- |
| G-A1 | ASSUMED | Precedence for a person in several groups: selector header, else lowest `priority`, equal lowest refused. Owner asked to confirm (brief requirement 8); owner unavailable 2026-10-22. Blast radius: resolver selection only (G3). |
| G-A2 | ASSUMED | Chargeback ID is set per group; no per-user override. Requirement 2 says "user or group"; users are onboarded only through groups. Blast radius: group schema, trace, export (G1, G7). |
| G-A3 | OPEN | Requirement 9, "removal of the group as a requirement": offboarding a group, onboarding users without a group, or removing one user. Not designed; G-REM is blocked on the owner. Not attached to an active packet. |
| G-A4 | ASSUMED | Owner decision 2026-10-22: no STD/PRM/CYB; each group is a separate entity. Transitional wire keeps `projectId`/`classification` (ADR-0034 decision 4) until G-WIRE. |
| G-R1 | OPEN | Realistic cache-read share of input tokens per workload/surface, with sources (G5). |
| G-R2 | OPEN | How each surface (chat, cowork, code, M365) reaches a Foundry gateway and how it identifies itself (G4). |
| G-R3 | OPEN | Power BI pull from an Entra-protected API: connector and auth requirements (G7). |
| G-R4 | OPEN | Least-privilege Graph application permission for group search and member count (G6). |

## Earlier packets

| ID | State | Question / evidence |
| --- | --- | --- |
| V3-N1 | RESOLVED | Graph GET `/users/{id}` application permission is `User.Read.All`; request only `id,displayName,userPrincipalName`. Source: [Get user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0), retrieved 2026-10-22. Grant to the admin managed identity, not the SPA or sync identity. |
| V3-N2 | ASSUMED | Names are current directory labels, not historical attribution. Object IDs remain authoritative. Memory-only bounded five-minute caches; no PII in persisted data or logs. Failed lookups retain IDs and show an explicit state. |
| S1-01 | RESOLVED | Azure accepted private/keyless Flex shells without runtime grants or network attachments in the tested lab configuration. Deployment and all-app read-back passed; see [live evidence](STAGE1-LIVE-VERIFICATION.md). Customer-policy compatibility remains unverified. |
| S1-02 | RESOLVED | New APIM cannot be treated as a private-only no-network shell. This proof leaves `approveNewPublicApimBootstrap=false`; APIM is explicitly deferred. See the existing [staged runbook](runbooks/STAGED-CUSTOMER-DEPLOYMENT.md). |
| S1-03 | ASSUMED | The authorized live proof uses a fresh RG in the isolated lab subscription already used by this session. It does not modify existing CCOF resources. Capacity/policy results apply only to this lab, not customer environments. |
| S1-04 | RESOLVED | Existing deployment paths bundle settings/grants/networking and are not Stage 1 substitutes. The recursive checks in `tests/Test-StagedCustomerDeployment.ps1` cover the separate `infra/staged` entry point. |
