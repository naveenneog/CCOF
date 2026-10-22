# Change log

## 2026-10-22 — Admin 3.1.0: Entra names and admin-only VDI upgrade

- V3 displays current Entra display names/UPNs beside full object IDs in Overview, Chargeback
  Developers, Budgets/Reconciler and Audit/Project Activity. Accounting, CSVs and filters keep IDs.
- Authenticated, bounded Graph lookup using the admin managed identity, enabled with
  `ADMIN_USER_NAMES_ENABLED=true` and Graph application `User.Read.All` with tenant admin consent.
  Missing users, denied permissions and provider failures keep IDs and other data available.
- Names are memory-only. Browser cache uses remaining server freshness, translated for clock
  skew, instead of restarting a five-minute TTL. Server lookup (including token acquisition) and
  browser queue have deadlines; failing batches cancel sibling requests.
- Added [manual VDI upgrade](ADMIN-V3-VDI-UPGRADE.md): existing managed identity consent, SPA
  redirect, private publishing, settings, verification and rollback. No changes to the gateway,
  sync, reconciler, APIM policies or deployed permissions.
- 108 admin tests, build/package, Edge UI/failure checks and the repository packet gate pass.

## 2026-10-21 — Network is the last setup stage

- New stage order: 0 checks, 1 resources, 2 schema, 3 grants, 4 Entra, 5 configuration,
  **6 network**, 7 code and data, 8 acceptance. As in the manual deployment, the customer usually
  builds the network; stages 2-5 do not need it, and Stage 7 requires it.
- `network.mode: verify` is the default: Stage 6 changes nothing and runs
  `scripts/manual/Test-NetworkConfiguration.ps1` (read-only) against the Stage 1 resources; a FAIL
  row stops it. `existing` and `create` (lab) remain opt-in.
- Templates and ARM deployment names follow the numbers: `stage2-schema`, `stage3-grants`,
  `stage5-config` (+ `stage5-api-telemetry`), `stage6-network`. An existing `state.json` moves to
  the new keys on first read (backup `state.layout1.json`).
- Fixes found on the way: the network check never reached Azure (`& az` recursed into its own
  `Az` function), failed on unrelated same-named DNS zones, and changed the CLI default
  subscription (`az account set`); the schema stage could not be rerun after grants; Stage 7 could
  not be rerun after a successful snapshot ([B-16 to B-20](../BUGS-FOUND.md)).
- Portal walkthrough steps and screenshots renumbered to match.

## 2026-10-21 — Portal walkthrough on both Standard v2 deployments

- Playwright walked the guide's 20 Portal steps on the signed-in FDPO/SASET and Contoso Portals:
  20/20 and 19/20 pass; the remaining Contoso step is the APIs blade staying on "Service is getting
  ready..." while ARM lists the API ([report](STAGED-STDV2-RUNS-2026-10-20.md#portal-walkthrough-with-playwright)).
- Walker fixes in `tests/playwright`: blade-menu navigation for sub-blades without a stable deep
  link, IAM **Role assignments** tab and list filters, reuse of the signed-in tab and its Portal
  host, one re-read for slow blades, literal-string masking. Two weak expectations were tightened;
  a negative control shows the resolver Authentication check fails on the wrong blade.
- The staged guide embeds 13 masked Contoso captures (`docs/runbooks/images/staged-portal`).
  Pages that list people are not published.

## 2026-10-20 — Staged deployment bug bash and live recheck

- Stage 1 shared-RG ownership now uses exact prior deployment resource IDs; the inventory verifier
  ignores unrelated and later-stage resources.
- Stage 2 create-mode retries skip the authoritative network deployment when a VNet already exists
  with saved state, and refuse to rewrite an existing VNet when that state is missing. DNS-link
  checks support earlier deployment outputs.
- Stage 8 acceptance uses the configured project header. Dependency hashes now migrate only when
  saved outputs match exactly or the relevant ARM outputs confirm the stable projection.
- Logged findings B-10 through B-15 in [`BUGS-FOUND.md`](../BUGS-FOUND.md). Offline staged,
  customer-deployment, quickstart and public-manual checks pass. Stage 1, Stage 2 and Stage 8
  acceptance rechecks and the Stage 4 grant recheck pass in both SASET and Contoso
  ([report](STAGED-STDV2-RUNS-2026-10-20.md)).

## 2026-10-20 — Standard v2 and private Foundry, SASET MSFT FDPO and Contoso

- Stage 1 can create a keyless private Foundry account with Claude deployments
  (`foundry-account.bicep`; `modelProviderData` required, API `2025-10-01-preview`).
- Stage 2 integrates a Standard v2 APIM with the VNet (outbound) and creates the Foundry private
  endpoint with its three DNS zones.
- `sharedResourceGroup` and the guarded Stage 1 rerun: what-if must not change resources outside
  the deployment's prefix. State is bound to tenant/subscription/RG. Stage 8 correlates telemetry by
  this run's request IDs.
- Live: SASET MSFT FDPO (shared RG) stages 0-8 with 200 responses; Contoso stages 0-8 with new
  Entra objects, Claude blocked by the sandbox subscription, Graph consent refused without an active
  admin role ([report](STAGED-STDV2-RUNS-2026-10-20.md)).

## 2026-10-20 — Manual Portal walkthrough and verification gaps

- Added click paths for the staged guide, Foundry setup prerequisites, Standard v2 outbound
  networking, IAM and Entra checks, and the operations that still need Bicep or CLI.
- Embedded five existing masked Portal screenshots beside the relevant steps. They are
  labelled historical navigation references, not new FDPO/Contoso deployment evidence.
- Real Playwright Portal probes for FDPO and Contoso reached the Microsoft sign-in page.
  Fresh blade captures and the requested Standard v2 runs remain blocked on sign-in and
  confirmation of the separate SASET/personal FDPO targets.
- Documented unresolved APIM integration, Foundry provisioning, cross-target state reuse
  (reproduced offline) and uncorrelated telemetry acceptance. Bicep compilation and existing
  stage tests pass but do not prove those missing behaviours.
- Playwright verified the rendered guide's five images and internal anchor. A broken-image
  negative control failed as intended, and restoring the image passed.

## 2026-10-20 — Stages 2-8 implemented and run live

- New entry points in `infra/staged`: `stage2-network.bicep`, `stage3-schema.bicep`,
  `stage4-grants.bicep`, `stage6-config.bicep` (+ `stage6-api-telemetry.bicep`), and the driver
  `Invoke-StagedDeployment.ps1` (stages 0-8: preview by default, apply, read-back, state).
  Configuration: `staged.config.example.json`.
- Stage 1: optional APIM moved into `apim-service.bicep` (what-if failed on the conditional scope);
  `BasicV2` allowed; outputs `names` and `apimName` for later stages.
- Live run in a new lab RG after deleting the Stage 1 RG: all nine stages verified, gateway
  401/200/403 matrix, Admin V3 with live chargeback data
  ([report](STAGED-LIVE-RUN-2026-10-20.md), 20 screenshots in `docs/images/staged`).
- Tests: `tests/Test-StagedStages.ps1` (stage boundaries with a negative control, Cosmos
  contract against the quickstart, driver and configuration checks).
- Runbook rewritten: [configurable staged deployment](runbooks/STAGED-DEPLOYMENT-V2.md).

## 2026-10-20 — Stage 1 resources-only proof

- Completed live provider verification of the existing staged templates in an
  isolated new lab RG: 20 template resources at read-back (Application Insights
  later auto-added four Failure Anomalies alert rules, recorded in the report);
  all four private/keyless service checks pass, and no schema, application settings or runtime grants were created.
  Existing inference/admin deployments were not write targets. APIM is deferred.
- Added a scoped work ledger and local Ironclad charter/gate without installing
  hooks or changing CI. The stage contract remains the existing resources-only
  template and recursive offline test.
- Added the Stage 1 [live report](STAGE1-LIVE-VERIFICATION.md) and
  [permission/configuration/runbook](runbooks/STAGED-DEPLOYMENT-V2.md).
- Full packet gate, root regression/type-check/build and 95 admin tests pass.
  Later-stage entry points, Admin V3 Azure acceptance and scale/accessibility
  verification remain pending.
