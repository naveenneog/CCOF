# Current work

## Release 22 (2026-10-28)

**Active packet:** R22 — merge G-GROUPS-ONLY and G-DAY into `release/22` from `main` `e8d9353`.

- Council: security review PASS (no findings); code review PASS-WITH-NOTES, two Low findings fixed test-first
  (Overview historical budget keys, duplicate ADR number, commit `89d3e2b`). Admin tests 221/0; packet gate rerun after the fixes.

## Deployment-day readiness (2026-10-27)

**Active packet:** G-DAY — novice HA deployment-day checklist and live multi-group rehearsal.

- Acceptance: a linked guide below 15 KiB covers advance approvals, each stage and measured timing,
  HA settings, two-group onboarding and explicit go/no-go checks; reader contracts fail first and mutations fail.
- Live evidence stays outside the repository. Never claim three-developer or 25,000-developer load proof
  from a single signed-in identity. No shared registration changes or console source edits.
- Checks: reader tests, full tests, explicit typecheck, build, admin tests and packet gate.
- Independent council review remains with the coordinator; no nested agents are authorized.
- Implemented: deployment-day timeline/screens, decision-led configuration with a complete offline-validated HA
  example, client/fleet onboarding and sizing worksheet. All three day pages stay below 15 KiB LF.
- RED: missing day/config/users/evidence pages; valid JSON breaker ranges refused; a console-added expected group
  refused by Stage 8. Fix commits: `09b3490` (JSON integer ranges), `929ec0b` (console group trace assertion).
- Targeted GREEN: 29 reader tests, 75 Foundry failover checks, 544 staged checks, 13 cross-platform checks;
  47/47 scoped mutations killed. First full-suite failure exposed unqualified Windows-only examples; these
  now carry explicit platform labels without changing the existing deployer guard.
- Live: second group onboarded/synced; both explicit selectors and the higher-spend default returned 200,
  group-specific denial returned 403 with allowed models, usage shows both budgets, and Stage 8 passed in 285 s.
  One identity only; provider 408/500 failures make rollout readiness conditional, not a clean enterprise acceptance.
- Seventeen pseudonymised images are checked and visually reviewed. The lab's stale console was updated using
  the unchanged released admin source only; both deployed snapshot links now open the correct group pages.
  Final console captures use the live deployment with a documented CLI-auth substitution.
- Self-review: Architect PASS (assertion is not routing/access); Coder PASS (small guarded changes);
  QA PASS-WITH-NOTES (negative/mutation coverage; one-identity/live-client limits); UX PASS-WITH-NOTES
  (timed decisions/screens, explicit unverified paths); Security PASS-WITH-NOTES (no new dependencies or grants,
  checked pseudonyms and per-user sign-in; existing dependency advisories are not waived).
- Final validation: `npm test` PASS (401.9 s in the final gate; Node suite has 1,340 pass/0 fail and six
  existing conditional skips), default typecheck PASS (2.2 s), build PASS (2.9 s). Explicit typecheck also
  PASS (2.6 s); admin 213/0 PASS (14.6 s). Final packet gate PASS (408.6 s): 23 pass, two existing warnings,
  zero failures. Final source candidate: `f8711d4`; code fixes `09b3490`, `929ec0b`, `bfc48e1`.
- Review follow-up requires actual group scope and charged Entra group ID, not only a GUID-shaped project ID.
  The saved real successful request passes the stronger live query/assertion without replaying inference
  or changing the saved Stage 8 record (`selection-scope-result.json` in private evidence).
- Large enrollment is not the small snapshot pilot: the example uses automatic Graph sync and count/row
  guards above the two-group scope footprint. Consent/warm-up, large snapshot alternatives, RU/memory/query
  performance and pilot token quotas are explicit prerequisites, not claims of 25,000-developer capacity.
- Verify-mode network connections to new targets are sequenced after Stage 1 and before Stage 6, not
  incorrectly required before those resources exist. The network-sequencing regression has its own RED/kill.
- Independent coordinator review/publication remains required. This packet does not clear customer Cosmos
  capacity, enterprise quota/load, three-developer acceptance or provider-reliability prerequisites.

## Group-only admin console (2026-10-27)

**Active packet:** G-GROUPS-ONLY — DONE: remove legacy project management and classification
controls from admin/ui-v3, retaining legacy server enforcement (ADR-0054).

- **Resumed by owner:** new deployments and UI are group-only; obsolete deployments
  are separately decommissioned. Preserve server/schema handling as the minimal
  safe boundary; no Azure, runtime or server changes in this packet.
- Acceptance: group-only navigation, cost/budget/Foundry controls and demo; historical
  non-GUID scopes remain visible without management links; old project bookmarks
  explain the removal and link to Groups.
- Verification: rendering tests first, guard mutations, Edge demo navigation,
  admin/root tests and build/typecheck, packet gate and added-line leak scan.
- Unknowns: GO-1 and GO-2 researched; GO-3 resolved by the owner's minimal-scope approval.
- RED checkpoint: 13 focused tests load, 2 pass and 11 fail. This is intentionally
  incomplete test-first work, not a green implementation or completed packet.
- GREEN: 31 focused tests and all 219 admin tests pass. Removed the four exclusive
  legacy modules after extracting their shared helpers. ADR-0054 records the
  approved group-only UI and independently coordinated decommission boundary.
- Edge: all 12 nav pages and group onboarding load, seven group links open group
  detail, manual GUID entry works, seven chargeback tabs load and five old bookmark
  forms lead to Groups. Final 28 checks, zero page errors, no legacy project or
  classification API reads. Seeded groups resolve in the synthetic directory;
  spare directory groups remain available for onboarding. Demo process stopped.
- Commits: RED contract checkpoint `7b94b88`; first GREEN implementation `2683aef`.
- Mutation verification: six guards caught with all 219 admin tests loaded each
  time; no suite-load failure counted. Restored baseline passes 219/219.
- Final checks: admin tests/build, requested root typecheck, root npm test/build
  and packet gate PASS. Gate: 23 passed, 2 existing warnings (five oversized
  historical files and G-R3/E2E-01/CC-01), zero failures; lint skipped because no
  command is declared. Added-line leak scan: zero matches; whitespace diff clean.
  Evidence (private, kept outside the repository): REPORT, gate, mutation and browser results.
- Council (direct review; owner forbids additional agents): Architect PASS (shared
  helpers extracted, ADR boundary and unchanged server/schema); Coder PASS (no
  deleted-page imports, shared scope links); QA PASS (RED evidence, mixed/group-only
  fixtures, negative scope checks and six full-suite mutations); UX PASS (12 nav
  pages, old-bookmark notice, manual-entry regression fixed, preserved accessible
  labels and empty/error/loading states); Security PASS-WITH-NOTES (GUID guards,
  React escaping and existing authorization unchanged; existing dependency findings
  tracked as G-DEPENDENCY-AUDIT, no new dependencies).

## Admin group navigation (2026-10-27)

**Active packet:** G-ADMIN-NAV — group budget snapshots and other shared console links open Groups, not Legacy projects.

- Acceptance: Budgets and Reconciler snapshots, Overview alerts/activity, Audit and Chargeback open group IDs on
  their group pages; legacy project links retain their sections. Budgets reads group details from the group API
  before requesting its burn-down; Foundry lists linked groups as well as legacy projects.
- Evidence: a user screenshot showed a group Object ID on a Legacy projects page with `project_not_found`.
- Verification: focused rendering tests and browser navigation with mixed group/legacy data, followed by the packet gate.
- Result: shared links now use `scopePath`; the burn-down selects `/api/groups/<id>` for group records and keeps
  classification lookup for legacy projects. Foundry combines backend-filtered group summaries with legacy projects.
- Evidence: rendering tests reproduced seven failures before the fix, including the snapshot link and wrong API
  lookup. Browser checks followed eight group links and a legacy budget link, then loaded the other console pages;
  no group ID was requested through `/api/projects`. Three isolated mutations caught routing, burn-down and
  backend-filter regressions with the full test count intact.
- Council (coordinator): Architect PASS (shared existing GUID convention, no API/schema change); Coder PASS
  (one route helper); QA PASS (mixed records, preserved legacy routes, rendering and browser checks); UX PASS
  (correct destination and group wording, explicit missing-data/error states); Security PASS (unchanged API auth,
  encoded legacy identifiers, GUID-validated group links).

## Release 20 (2026-10-27)

**Active packet:** G-HA — opt-in zone redundancy and Foundry failover with a circuit breaker, configured in the
configuration file, with Stage 0 suggestions for the admin and a first-time-reader page (owner instruction 2026-10-27:
"lets build an option of zone redundancy and circuit breaker for foundry with HA option and way to define those in
the config file and suggestions to admin").

- G-HA-ZONES ([ADR-0052](adr/0052-opt-in-zone-redundancy.md), [page](get-started/high-availability.md)): create-only
  zone redundancy for API Management (zones and units), Function Apps (Flex Consumption) and storage (ZRS); Stage 0
  HA check with suggestion lines; read-backs. Live, Central India lab, 2026-10-27: Stages 0-8 passed; ARM read back API
  Management zones with 2 units, four zone-redundant Flex Consumption plans and five ZRS accounts. Cosmos DB zone
  redundancy in Central India was refused twice for capacity (also on 2026-10-26); the run used
  `isZoneRedundant: false` and the page says how to request capacity. Stage 0 and the Stage 7 preview now refuse client
  model aliases that name no deployment before anything is published.
- G-HA-FOUNDRY ([ADR-0053](adr/0053-foundry-priority-failover.md), [page](get-started/foundry-failover.md)): a backend
  can name a standby Foundry account; Stage 5 creates API Management backends with a circuit breaker (429 and 5xx,
  `Retry-After` honoured) and a priority pool under the same backend ID, so budgets and chargeback are unchanged.
  Live drill on a lab: the primary returned 429, the breaker tripped, the standby answered 200, and traffic returned to
  the primary after the trip duration.
- Reviews: each branch had one Coder/QA BLOCK, fixed test-first, then PASS; security reviews found nothing.

## Release 18 (2026-10-27)

**Active packet:** G-R18 — first-time-reader deployment in Central India (Foundry in East US 2), provisioned
Cosmos DB with South India as the failover region, bug bash 5 and live security test, and their fixes (owner instructions
2026-10-26: "test the setup on central India region with provisioned cosmos and find the region for failover" and
2026-10-27: "do bug bash and security testing and fix any issues found").

- Merged on `release/18`: `test/novice5` (`stage1.foundry.location`, region-and-failover page), `fix/r18-staged`
  (AO-1, AO-2, AO-4, AO-5, AO-8; AO-3 answered by accurate preview wording after review withdrew the no-op apply),
  `fix/r18-client` (DG-1..DG-8, AO-6, AO-7). Bug bash 5: developer and gateway 8 findings, admin and operations 8;
  live security test (237 requests) and code security review of release 17: no findings.
- Reviews: both fix branches BLOCKed once, fixed, then PASS (Coder, QA). Open: BB5-H2 (HTTP/2 request bodies without
  `Content-Length` have no gateway size bound; APIM behaviour unverified).

## Bug bash 5 staged driver

**Active packet:** G-R18-STAGED-REVIEW — COMPLETE; coordinator re-review/integration pending.
Coordinator decision: configuration/dependency hashes do not cover template/effective-parameter changes;
existing read-back cannot certify skipped configuration, and failed applies can leave stale completion state.
Stage 2/5 `-Apply` now always deploys the current template, as in release 17. AO-3 is answered by accurate
unchanged-preview wording, not a no-op guarantee; Stage 5 Function App restarts are documented.
The no-op/force behavior and its tests were withdrawn by review, not weakened to pass. The replacement
regressions cover both unchanged previews, current templates/effective parameters, failed-B-to-A recovery,
and the retained AO-4 changed-parameter assertions.

AO-1/2 remain fixed: Stage 1 keeps the Stage 5 record shape; recovery tolerates later resources without inferring
later completion, retaining recorded grant-count checks and the Stage 2 before/after assignment comparison.
AO-4/5/8 and novice Low fixes are implemented: named parameter diffs, actionable private-Cosmos warning,
outage/manual-write-and-read drill guidance, separate Foundry regions, seed creation evidence, timing and links.
GREEN: redeployment 23 checks; recovery 11; reader links/output/page budgets 3; six targeted mutations killed
with loaded suites and expected test failures. Root/admin `npm ci`, admin 203 tests, explicit typecheck/build,
and full packet gate passed (including `npm test`, 360.8 seconds). Gate: 23 passed, 2 existing warning
categories (oversized files/open unknowns), 0 failed. No live applies or pushes.
Withdrawal implementation: `a5a9dd6`.

Self-review, not independent council approval: ARCHITECT PASS — release-17 apply contract restored;
CODER PASS — no completion-record shortcut on apply; QA PASS — wording, current inputs and failed-B-to-A
regressions plus six mutations; UX PASS — restart/redeployment disclosed; SECURITY PASS — no new writer,
dependency or credential exposure. The external Coder/QA BLOCK is addressed by withdrawal, not by claiming
the former read-back can certify drift; coordinator owns independent re-review.

## Bug bash 5 client packet (2026-10-27)

**Active packet:** G-BB5-CLIENT — DG-1–DG-8 and AO-6/7, branch `fix/r18-client`.
Acceptance: downloaded config can be deleted after setup; setup errors name the path and option;
gateway refuses explicit chunking and normalizes backend errors; usage states pacing accurately;
budget-key semantics are explicit; sign-in probes are quiet; admin names are visible and safe.
No live changes. [ADR-0050](adr/0050-import-client-configuration.md).

**State:** review follow-up implemented and offline-green, ready for coordinator re-review;
no push or live deployment.
DG-1/2 `4f9c987` (safety `bf833c6`, entrypoint proof `bbc8d2b`); DG-3 `70e5b65`;
DG-4 `5c903a5` (SSE contract `8fdb210`); DG-5 `3cd182b` (zero ceiling `9a6329a`);
DG-6 `36b72a4` ([ADR-0051](adr/0051-retain-pacing-debt-for-reused-budgets.md));
DG-7 `1a417c0` (triage only); DG-8 `dd164f3`; AO-6 `9603675`; AO-7 `21594db`.

Validation: root/admin `npm ci`; full `npm test` through the packet gate; admin tests 203/203;
`npx tsc -p tsconfig.typecheck.json --noEmit`; `npm run build`; packet gate **PASS**
(23 passed, two pre-existing warning groups: file size and unrelated open unknowns).
25/25 targeted guard mutations caught; added-line leak scan zero matches.
All commands used the isolated Azure CLI profile; no live lab was contacted.
Native macOS was not exercised. Dependency installation reports two existing high-severity
audit findings in each package tree; this packet changes no dependencies.

Review follow-up: `85cf4f8` moves publication after preflight, includes the shared configuration
in client snapshots, rolls back failed writes/completion, and makes Restore recover it.
Public failed/not-installed paths and both Code/Desktop success/rollback/Restore cases pass.
`326019f` refuses explicit chunked transfer tokens only; absent Content-Length alone is allowed.
[BB5-H2](UNKNOWNS.md#bug-bash-5-review-follow-up) records SDK/loopback evidence and the unproven
APIM HTTP/2 exposure. Nine further guard mutants caught. Fresh root/admin installs, admin tests
(203/203), CI typecheck, build and full packet gate PASS; the gate's `npm test` took 344.6 seconds.

## Release 17 (2026-10-26)

**Active packet:** G-R17 — integrate the bug-bash fixes, the macOS deployer and developer setup, and deployment into an
existing API Management; merge into main and publish (owner instruction 2026-10-26: "finish the pending tasks push to
github ... user is running a powershell from mac, novice user deployment to existing APIM is what we need").

- Branches merged on `release/17`: `test/novice3` (G-NOVICE3), `fix/bugbash-admin`, `fix/bugbash-ops`,
  `fix/bugbash-gateway` (G-BUGBASH-GW), `fix/macos` (G-MACOS), `fix/macos-client` (G-MACOS-CLIENT),
  `feature/existing-apim` (G-EXAPIM). Bug bash 2026-10-26 on a lab: 41 findings (developer 16, admin 11, operations 8, gateway 6) across developer, admin, operations and
  gateway areas; all fixed except DEV-9 (cache-read tokens of streamed replies stay unpriced; documented as a lower
  bound). Security review of the long-term audit: no findings.
- Not verified on a real Mac: the deployer and developer setup ran on Linux PowerShell 7 (UNKNOWNS MAC-2).

## Existing API Management

**Active packet:** G-EXAPIM — a first-time reader deploys CCOF into an existing API Management instance (branch
`feature/existing-apim`, [ADR-0045](adr/0045-existing-api-management.md)).

- Acceptance: (1) Stage 0 checks the named instance (readable, identity, tier, API ID/path, backend names,
  diagnostic-setting room, network route) and refuses with a next step before anything is created; the global policy
  is printed, never changed; (2) Stage 5 sends GatewayLogs and GatewayLlmLogs to CCOF's workspace through
  `ccof-gateway-logs` (or reuses an equivalent setting) and reads it back; (3) the owner's other APIs, global policy,
  logger and own diagnostic settings are unchanged after Stages 0–8; (4) Stage 8 telemetry passes on an existing
  instance; (5) a reader page "Use an existing API Management" linked from prerequisites and deploy.
- Live, lab, 2026-10-26 ([evidence](evidence/2026-10-26-existing-apim/README.md)): a simulated customer instance
  (Standard v2, its own API, global policy and diagnostic setting, created outside CCOF); the deployer on Linux
  PowerShell (WSL, standing in for a Mac). Stages 0–8 passed: 52, 302, 229, 426, 44, 109, 697, 822, 278 s. Stage 5
  what-if was `Create` only on the instance; Stage 8 telemetry came through `ccof-gateway-logs`; the ledger
  attributed both requests to the group; `claude -p` through the instance answered. The owner's tier, identity,
  networking, other API and its policy, global policy, logger and own diagnostic setting read back unchanged. A
  private Foundry was refused live at Stage 0 (`apim_existing_no_private_route`).
- Checks: new suite `tests/Test-StagedApimExisting.ps1` (57 checks), mutations 30/30 caught; Stage 0 keeps a hash of the global policy in `stage0.json`, not its text; `npm test`, CI
  typecheck, build, admin tests, `node .ironclad/gate.mjs --stage packet`.
- Open: manual removal from the instance; a private Foundry behind a VNet-integrated instance not run live; create
  mode still adds an unused API Management subnet.
- State: complete; merged on `release/17` (owner approval 2026-10-26).

## Group-centric onboarding

**Active packet:** G-AUDIT — long-term audit: gateway log archive and chargeback history (feature branch
`feature/long-term-audit`, merged into main on 2026-10-26 with the owner's approval, merge commit 2265e25; [ADR-0043](adr/0043-long-term-audit-archive.md),
[ADR-0044](adr/0044-chargeback-history-in-cosmos.md)).

### G-AUDIT — long-term audit (feature branch, 2026-10-26)

- Acceptance: (1) API Management gateway logs archived to a storage account in Stage 5 (`audit.archive`), kept for
  `retentionDays` with an optional immutability policy; (2) the reconciler writes daily chargeback totals to Cosmos DB
  (`audit.chargebackHistory`), and the admin usage export reads months older than the Log Analytics window from them,
  refusing days history does not cover (`409 history_not_covered`) or that have expired (`409 history_expired`);
  (3) neither feature can delay or fail budget enforcement; (4) existing configurations without `audit` keep their
  stage hashes; (5) documentation a first-time reader can follow.
- Process: two parallel build branches (archive, history), integrated, then four council rounds (Architect, Coder,
  QA, UX, Security) plus a first-time-reader review; blocking findings fixed test-first in three fix rounds; final
  verdicts PASS or PASS-WITH-NOTES; first-reader ratings 5/3/4 → 8/8/8.
- Live, lab, 2026-10-26: Stages 0, 2, 3, 5, 7, 8 passed from the branch. History: reconciler run lines
  `historyOutcome: written`; current-month export 200; previous month `409 history_not_covered` (JSON and CSV);
  budgets and `/usage` unchanged. Archive: a management-group storage policy turned the account's public network
  access off; Azure Monitor still delivered (storage metrics: `PutBlob`/`AppendBlock` successes with OAuth, Shared Key
  disabled), and Stage 5 now accepts that state (public access off, default Deny, trusted services allowed). Re-proof:
  writes appeared about 5 minutes after the requests; about 6–7 KB per request in the archive.
- Private reads, lab, 2026-10-26, from a temporary runner inside the VNet (managed identity, archive private
  endpoint, container-scoped reader roles; all removed afterwards and the original settings read back unchanged):
  both archive categories held all 15 request IDs of the earlier traffic and no prompt or completion text; the
  daily history documents and the coverage record matched the Log Analytics export totals; the deletion tool's
  what-if ran on real history (an old month: 0 documents; the current month: refused), and `--confirm` deleted
  only synthetic documents in a disposable container, with a repeat run deleting nothing.
- Not checked live: an admin export answered from history (`sources`, `X-CCOF-History-Open-Days`). The export
  reads history only for months before the current one, and the first covered month is still current; possible
  from the first day of the next month.
- Checks: full `npm test` 1304 passed, CI typecheck and build, 41 Bicep templates, docs and admin tests,
  `node .ironclad/gate.mjs --stage packet` PASS; mutation checks on every new guard.
- Follow-up (non-blocking): a per-person history deletion that stops part-way is not yet marked as in progress, and
  exports do not yet show that a person's history was deleted.

### G-MACOS-CLIENT — Claude Code setup on macOS and Linux (branch `fix/macos-client`, 2026-10-26)

- Acceptance: given a client configuration with `signInMethod: azure-cli`, `pwsh ./scripts/client/Set-ClaudeCodeGateway.ps1
  -Confirmed` on macOS or Linux writes `~/.claude/settings.json` (gateway `env` as on Windows) and an `sh` helper
  `~/.claude/ccof-token` (700) pinned to the `az` found at setup, with its own `AZURE_CONFIG_DIR` (700) and the verbs
  `token`/`silent-token`/`login`/`status`/`logout`, printing only the token; `/usage` and the status line run through
  `pwsh -NoProfile -File`, pre-approved by the skill; another sign-in method stops with `unsupported_sign_in_method`
  before writing; Windows output unchanged ([ADR-0048](adr/0048-claude-code-setup-on-macos-and-linux.md), UNKNOWNS
  MAC-4..MAC-9).
- Tests: `tests/Test-ClaudeCodePosix.ps1` (6 cases on Windows with the platform simulated, 12 on Linux pwsh: `sh` helper
  against a mock `az`, file modes, a quote and space in the home path under `/bin/sh`, entrypoints end to end with
  restore); Test-CrossPlatform (Claude Code entrypoints carry no `unsupported_platform` guard); client Node tests for the
  `sh` helper and messages. 18 mutations caught (2 only catchable off Windows).
- Live, Linux pwsh 7.6.9 in WSL, Azure CLI 2.91.0, Claude Code 2.1.272, a lab deployment (sign-in replaced by a copy
  of a signed-in Linux Azure CLI profile in the helper's own folder, deleted afterwards): `silent-token` before sign-in
  exit 4 with nothing on stdout; after: a JWT, and the same token from `apiKeyHelper` under `/bin/sh`; gateway
  `POST /v1/messages` `429` "tokens-per-minute limit" (the test account's known guard block, UNKNOWNS DEV-3; a bad token
  gets `401`), so the helper's token was accepted; `claude -p` "API Error: Request rejected (429) … tokens-per-minute
  limit"; the `/usage` wrapper and the status line command read `GET /anthropic/ccof/me/usage`
  (`CCOF $0.01/$100.00 (0%)`); the generated skill command and grant ran under Claude Code's Bash tool and its lines
  reached the model (a copy without the grant: "permission check failed"); the verifier: token verified, `429`.
- Not verified on a Mac: the browser `az login` from the helper, Homebrew paths, the Azure CLI cask's broker sign-in,
  APFS modes (UNKNOWNS MAC-8). Not supported: `msal` and Claude Desktop on macOS (ROADMAP G-MACOS-MSAL, G-MACOS-DESKTOP).
- Checks: Windows `npm ci` (root, admin), CI typecheck, build, admin 203/0, `npm test` Node 1305 passed with one failure
  that predates this branch (`get-started and operate pages stay short (15 KB)`: `03-deploy.md` is 15,580 bytes in a
  Windows CRLF checkout, 15,220 with LF; fails identically on `release/17` c7cdbe0), every PowerShell suite green;
  Linux pwsh `npm test` exit 0 (Node 1306/0, 6 skipped, every PowerShell suite). Council: Coder PASS, QA PASS,
  Security PASS-WITH-NOTES (`pwsh` is found on `PATH` at run time, as `powershell` is on Windows; pinning it is
  optional hardening), Architect and UX PASS (ADR-0048; one platform table, refusals name their remedy).

### G-MACOS — the deployer on macOS (branch `fix/macos`, 2026-10-26)

- Acceptance: a deployer runs Stages 0-8 from PowerShell 7 on macOS by following the pages; the docs give the macOS
  install route; what macOS developers can and cannot use is stated, and the Windows-only setup refuses cleanly.
- Proof on Linux pwsh 7.6 (WSL Ubuntu 24.04, the closest available to macOS; no Mac was used): full `npm test` green
  (Node 1305 passed); Stage 0 and the previews of Stages 1-8 against the lab with a copy of its Windows-made state
  folder (same what-if counts as Windows); resolver, sync, reconciler and admin packages built, zipped and their entry
  points loaded under Node 22.
- Found and fixed: config path guard for cmd.exe applied off Windows; `Remove-Item` without `-Force` left dot-files
  on macOS/Linux; deployer page passed `.\dist\...` to node; client setup failed half-way on macOS (now
  `unsupported_platform`); test harness tied to Windows (bicep.exe, python, az.cmd fake, CRLF hashes, skip count).
- Bug bash DEV-1/DEV-2 (developer area): `/usage` skill pre-approves its own command (Bash or PowerShell tool), probed
  with Claude Code 2.1.272 on Windows and Linux; docs separate interactive `/usage`, `claude -p`, and a refused budget
  (status line, wrapper). DEV-3 (guard `429` outlives a raised budget) recorded as UNKNOWNS DEV-3, not analysed.
- Not verified on a real Mac: everything above (UNKNOWNS MAC-2); macOS developer setup (MAC-1, G-MACOS-CLIENT).
- Checks (Windows): `npm test` 1305/0 plus every PowerShell suite, CI typecheck, build, 41 Bicep templates, admin
  183/0, `node .ironclad/gate.mjs --stage packet`.

### G-BUGBASH-GW — gateway and developer bug-bash fixes (branch `fix/bugbash-gateway`, 2026-10-26)

- Scope: findings DEV-3, DEV-5..DEV-16 and GW-1..GW-6 of the 2026-10-26 bug bash (DEV-1, DEV-2, DEV-4 are on
  `fix/macos`). Decisions: [ADR-0047](adr/0047-budget-pacing-counter.md) (budget pacing on its own counter keyed by
  budget and month), [ADR-0048](adr/0048-request-checks-and-backend-refusals.md) (path, content-type and size checks
  before forwarding; backend 4xx other than 429 priced at zero). Unknowns BB-G1..BB-G7.
- Commits: 902a94a (DEV-3, DEV-6, DEV-7), f5cee9e (GW-2, GW-3, GW-4), 43b441d (GW-1, GW-5, DEV-8, DEV-10, DEV-15),
  d972cdc (GW-6), 75ee895 (DEV-9, DEV-13, DEV-14), d99e5d9 (DEV-5, DEV-11, DEV-12, DEV-16).
- Proof so far: offline only (tests, compiled policy C#, mutation checks on every new guard). Not applied to a lab:
  live proof of the pacing counter after a budget raise (BB-G1) is the coordinator's decision.
- Not fixed: DEV-9's unpriced cache tokens of streamed replies (needs a non-buffering SSE usage reader, COST-MODEL
  U-17); documented as a lower bound.
**Previous packet:** G-RESUME — Stage 1 read-back after lost local state (complete; [ROADMAP](ROADMAP.md)).

### G-RESUME — Stage 1 read-back after lost local state (complete, 2026-10-25)

- Live evidence (user run, 2026-10-25): Azure Cloud Shell without persistent storage lost `$HOME`, including
  `.staged-state`, during Stage 6. After a fresh clone, Stage 1 failed with
  `verify_failed: <app> VNet subnet is '/subscriptions/.../subnets/snet-functions', expected '' for completed stages`:
  Stage 6 had already integrated the Function Apps, and with no Stage 6 record the read-back accepted only no integration.
- Acceptance: with a Stage 6 record, Stage 1 accepts only that record's Functions subnet; without one, it accepts no
  integration or the Functions subnet the configuration names (`network.existing.functionsSubnetId`, or in create mode
  the subnet built from `network.create.vnetName` and `subnets.functions.name`). Any other subnet still fails.
- Code: `Get-StgAllowedFunctionsSubnets` in `infra/staged/Staged.Common.ps1`, used by `Test-Stage1` in
  `infra/staged/Staged.Resources.ps1`. Three rows added to [troubleshooting](operate/troubleshooting.md): Cloud Shell
  idle timeout, recovery after lost `$HOME`, and this error.
- Checks: `tests/Test-StagedStages.ps1` 499 checks pass (a mutation that dropped the `''` case was caught); docs tests
  27/27; packet gate PASS (23 passed, 2 warned, 0 failed, includes `npm test`), all in a logged-out Azure CLI profile.
- Source commit: `9091ad5` (`fix(staged): accept the configured Functions subnet at Stage 1 after lost state`), local `main`.
- Public release 15: `07900bc` on `naveenneog/CCOF` `main`, the `f368d2d..9091ad5` diff (G-CONFIG-GUIDE-2 and G-RESUME)
  applied with no conflicts. The planned base `e5e7d8d` conflicted in 7 files because release 14 already holds
  `e5e7d8d..f368d2d`; `f368d2d..06a8489` is only STATUS, so `f368d2d` is the base. Scrub check: 16 matches, all
  hypothetical `contoso` examples (5 new on `configuration-resources.md`, 1 in the release 14 STATUS line, kept as
  written). No real lab identifier in the public tree; gitleaks: the 3 known `projectApi` false positives; docs tests
  27/27; public CI run `40209444154` success.

**Previous packet:** G-CONFIG-GUIDE-2 — configuration reference reworked (complete; [ROADMAP](ROADMAP.md)).

### G-CONFIG-GUIDE-2 — configuration reference reworked (complete, 2026-10-25)

- Owner feedback: the page named only some keys and showed one `entra.existing` ID. Acceptance: for each reuse-or-create
  choice (Entra applications, groups, Foundry and backends, network, API Management, Cosmos DB) both forms as JSON with
  the lines the stage prints; every leaf key of the template in a table with required, template value, allowed values
  and reader; one complete sample that `Read-StgConfig` accepts.
- Pages: `configuration.md` (choices, commands, sample), `configuration-identity.md`, `configuration-resources.md` and
  three `configuration-reference*.md` tables, each under the 15 KB reader-page limit.
- Tests (`tests/docs-reader-pages.test.ts`): the template's leaf paths, arrays collapsed, must all be named on the
  pages (failed first: the split pages did not exist); every JSON block parses; the sample block runs through
  `Read-StgConfig` in `pwsh`. Negative: removing `gateway.keyVersion` failed the leaf test, a non-GUID `tenantId` in the
  sample failed the sample test; both restored.
- Facts read from `Resolve-StgApp`, `Invoke-Stage4`, Stage 0, `Read-StgConfig`, `main.bicep`, `stage6-network.bicep`,
  `network.bicep`. Not code-verified: the Application Administrator role for reused applications (Learn), the meanings of
  the gateway, resolver and reconciler tuning keys beyond their units.

**Previous packet:** G-CONFIG-GUIDE — configuration reference page (complete; [ROADMAP](ROADMAP.md)).

### G-CONFIG-GUIDE — configuration reference page (complete, 2026-10-25)

- Acceptance: one page, [configuration.md](get-started/configuration.md), names every template key that holds a
  `REPLACE-` value or is a decision key, with what it is, where to get the value and a hypothetical lab example;
  it is linked from the deploy page (Before Stage 0) and the documentation map.
- Checks: a test in `tests/docs-reader-pages.test.ts` computes the `REPLACE-` key paths from the template and adds
  the decision keys; it failed first because the page did not exist, passes with it, and failed again when one key
  (`groups[].familyPolicy`) was removed from the page. Claims were read from `Read-StgConfig`, the Cosmos, Groups
  and Resources scripts and the Stage 5 Bicep. Docs tests pass.
- Source commit: `d1c4eeb` (`docs: add configuration reference page for the staged configuration file`), local `main`.
- Checks run: `npm test` 80/80 and the packet gate PASS (23 passed, 2 warned, 0 failed), both in a logged-out Azure CLI profile.

**Previous packet:** G-NOVICE — first-time reader deployment from the README (complete; [ROADMAP](ROADMAP.md), [evidence](evidence/2026-10-25-novice/README.md)).

- Public release 14: `5604486` on `naveenneog/CCOF` `main`, the `e5e7d8d..f368d2d` diff applied with no conflicts. Scrub check: 10 matches, all hypothetical `contoso` examples (3 new on the configuration page, kept as written). No real lab identifier in the public tree; gitleaks: the 3 known `projectApi` false positives; docs tests 25/25; public CI run `40195975284` success.
### G-NOVICE — first-time reader deployment (complete, 2026-10-25)

- Acceptance: a reader following only the README and get-started pages reaches Stage 8 and a working developer
  setup with `signInMethod: azure-cli`; each failure met is captured, and is either refused at Stage 0 with the fix
  named or explained where it is met; developers have one sign-in step for both methods.
- Live: attempt 1 (`ccof-nov-rg`) stopped at Stage 3 and was deleted (Stage 1 is create-only; Foundry account
  purged to free 20 + 20 DataZone units). Attempt 2 (`ccof-nov2-rg`) passed Stages 0-8; Stage 8 anonymous `401`,
  Haiku `200`, Opus `403`. Developer setup from page 5 in a scratch profile: `claude -p` answered, `/usage` showed
  USD 0 of 100. The interactive sign-in window was replaced by a copy of an already signed-in profile.
- Code fixes (each failing first): Stage 0 refuses no API Management and a private Foundry account without a private
  endpoint; Stage 1 create-only messages; Stage 6 read-back skips Foundry zones it did not create and redeploys its
  own network after a failed read-back; changed-config errors name every affected stage; ARM errors lead with
  resource, code and innermost message; setup prints `signInMethod` and `signIn`.
- Council: round 1 Architect BLOCK (Stage 6 recovery trusted any succeeded `stage6-network` deployment); Coder and
  QA PASS-WITH-NOTES (same guard, duplicate AZ-05 row); UX PASS-WITH-NOTES (Desktop sign-in wording, capture omitted
  the model notice); Security PASS (hardening note on the same guard). Fixed with failing tests first: the guard now
  requires create mode, this VNet's `vnetId` output, unchanged `network.create` and a non-shared resource group
  (verified on the live deployment), [ADR-0042](adr/0042-stage0-refusals-and-stage6-recovery.md). Round 2: Architect
  PASS, UX PASS-WITH-NOTES (Desktop links, fixed).
- Open: CC-01 (Claude Code model-catalog notice), next packet G-CCMODEL. Decision record:
  [ADR-0042](adr/0042-stage0-refusals-and-stage6-recovery.md).

**Previous packet:** G-AZCLI — Azure CLI developer sign-in (complete; [ADR-0041](adr/0041-azure-cli-developer-sign-in.md)).

### G-AZCLI — Azure CLI developer sign-in (complete, 2026-10-25)

Acceptance:
- Given `signInMethod: azure-cli`, Claude Code setup writes `ccof-token.cmd` that runs `az login` once when no
  cached token exists, in the profile `<config folder>\az`, and prints only the token; `settings.json` points
  `apiKeyHelper` at it with a cache time of at most 240 s.
- Claude Desktop setup writes a `helper-script` profile using the same helper, even when `external-idp` is
  supported.
- `/usage` gets its token from that helper.
- Unsafe tenant, scope or folder values are refused before any file is written.
- Stage 7 writes `signInMethod` only when Stage 4 allowed the Azure CLI; Stage 4 reads back the preauthorization.
- Live: the helper's token is accepted by the gateway (HTTP 200) and its claims match AZ-01.

Result:
- Checks: client Node 77/77; client PowerShell 46/46 (a planted `az.cmd` in the working folder or first on `PATH`
  never runs; a signed-out `silent-token` makes one token call and no sign-in); staged checks 478; full `npm test`
  with a logged-out isolated Azure CLI profile; `node .ironclad/gate.mjs --stage packet` PASS (22 passed, 3
  warnings: uncommitted size before this commit, file-size budget on files this packet does not touch, open G-R3 and
  E2E-01). Mutation checks on the helper generator and the Stage 7 ordering were caught.
- Test contract change: `tests/Test-AdminHandWorkbook.ps1` pinned the whole original workbook by hash, while
  `tests/manual-guide.test.ts` requires its nine hand-copy client source blocks to equal `client/`. The first client
  change since 2026-10-16 made the two contradict. The hash now covers the original text with those nine blocks
  replaced by a placeholder; the digest is identical at `28a0bad` and after this change. A prose edit and a source
  drift each still fail.
- Live, demo lab 2026-10-25 (Azure CLI 2.91.0): token claims as AZ-01; `/usage` returned the developer's groups;
  `POST /v1/messages` HTTP 200; `claude -p` with the generated `settings.json` answered `OK`, including from a
  folder holding a planted `az.cmd`, which did not run.
- Council round 1: Security HIGH (helper ran `az.cmd` by bare name, so a planted `az.cmd` in the project folder
  could run); Coder High (the status line could open a browser sign-in on every refresh); UX BLOCK (`/usage` turned
  every helper failure into "sign in first"); two Medium (Desktop-only helper path, late Stage 7 check). Each fixed
  with a failing test first. Round 2: Architect PASS-WITH-NOTES (the 240 s cap relies on the Azure CLI 2.91.0
  refresh floor, recorded in AZ-02); Coder PASS; QA PASS; UX PASS; Security PASS.

### G-DOCS-R2 — novice reader fixes (complete, 2026-10-24)

- Acceptance (novice review items 1-7): developer setup starts with getting the code; the stale capture note is
  gone; Stages 1-8 each show the preview command before `-Apply` and the preview's last line; the console names
  the earlier-model page **Legacy projects**; Stage 7 has a plain success checklist; the lab route gives a sourced
  rough daily cost and how to check actual spend; 13 earlier guides are in `docs/archive/` with a README. Item 8
  (the separate older repository) is out of scope by the owner's decision.
- Scope: documentation, one console label and tests; no Azure deployment. The 2026-10-24 console captures predate
  the label; the onboarding page, evidence README and ADMIN-V3 say so.
- Checks: reader docs 13/13 (5 new; each new detector negative-tested: a removed preview line, a former
  `docs/` path and a mis-rewritten archive link each fail it); admin 167/167; `npm build` of the console; full
  `npm test` with a logged-out isolated Azure CLI profile passed; repo-wide relative-link scan 35 broken before and
  after, all pre-existing (targets never committed). `node .ironclad/gate.mjs --stage packet` PASS (23 passed,
  2 pre-existing warnings: file-size budget on files this packet does not touch, and the open G-R3 and E2E-01
  unknowns; 1 skipped).
- Council: Architect PASS; Coder PASS (runtime paths in tests resolve; cited line numbers unchanged because the
  archive rewrites replace lines in place); QA PASS-WITH-NOTES (preview and archive tests tightened per section and
  for inbound paths; cost links now point at the filtered price queries); UX PASS-WITH-NOTES (screenshot label
  note added to the onboarding page); Security PASS (no exploitable findings in the diff, admin API authorization,
  CSV export, gateway enforcement or client token storage; no real identifiers in the diff).
- Source commits: `3de09e8`, `adb7005`, `921a192` and the ledger commit, local `main`.

### G-DOCS-R1 — first-time reader follow-up (complete, 2026-10-24)

- Acceptance: key deployment values shown; measured single-subscription lab route includes duration, permissions and
  charges; onboarding guide uses the readable review screen; exhausted-budget output uses the current status-line
  formatter; README summary uses reader-facing language. Complete.
- Scope: documentation and evidence only; no Azure deployment or product behavior changes. The screenshot was
  refreshed from the saved usage response; no paid model request was made.
- Checks: reader docs and pseudonymisation 13/13; client usage 16/16; `node .ironclad/gate.mjs --stage packet`
  PASS (23 passed, 2 pre-existing warnings for G-R3 and E2E-01, 1 skipped). Gate's full `npm test` passed.
- Council: Architect PASS (no architecture changes); Coder PASS (focused documentation and recorded output);
  QA PASS (new reader assertions and existing status-line regression); UX PASS (cost/permissions surfaced and
  field labels readable); Security PASS (configured identifier scan clean, no secrets or live calls).
- Source commit: `032aeb1` (`docs: clarify first-time setup and evidence`), local `main`; no Azure deployment.
- Public release 11: `fcb187c` on `naveenneog/CCOF` `main`, applied to `public-main` as the `2f84715..53bac48` diff.
  Scans of the published tree, 2026-10-24: release 11 adds no scrub-rule match. The scrub check reports 6 matches,
  all the hypothetical `lab-a.com` alias in `docs/evidence/2026-10-24-demo/README.md` (1) and
  `tests/docs-pseudonymise.test.ts` (5), published in release 10. The private-literal scan matches only the public
  repository name `naveenneog/CCOF` (clone URL in `docs/get-started/03-deploy.md`, CI links in ROADMAP/STATUS). The
  three GUIDs in `usage-03-refused.txt` are pseudonyms; none of the raw capture's GUIDs appear in `origin/main`.
  gitleaks clean; docs tests 13/13 on the public tree; public CI run `40110954891` success.

### G-DOCS — documentation refresh (2026-10-24, complete)

- Acceptance: short role-based pages, prerequisites and stages with expected outputs, live Portal and console
  captures with consistent hypothetical identifiers, own-usage states and chargeback CSV; links checked offline.
- Fresh `ccof-demo-rg` deployment: Stages 0-8 verified on their first runs. Product onboarded in the deployed
  console; 44 screenshots, with names and IDs replaced before capture.
- Demo guard 80 / 25 / 5: USD 2 person budget ended at USD 2.14 recorded (7% over); 71 succeeded, 95 throttled,
  69 refused. This is not a strict dollar ceiling. [Evidence](evidence/2026-10-24-demo/README.md).
- Live capture exposed an exhausted-status-line omission. RED: expected refusal text was absent; GREEN:
  client 68/68. Root 1206 pass and strict typecheck clean before recovery.
- Council round 1 found rehashed pseudonyms on repeat capture, unpinned developer login configuration and incorrect
  snapshot/cache instructions. Regression tests failed first; capture now restores the live DOM even on failure.
  Login uses the supplied absolute config; snapshot mode lists all registered groups explicitly.
- Council round 2: ARCHITECT, CODER, QA, UX and SECURITY PASS. Ten docs/capture tests pass; nine mutations caught
  with all five tests loading in each targeted suite. Client 68/68; exported suite 1212 pass, six opt-in live tests
  skipped, zero failed; strict typecheck and packet gate pass. Fifteen reader-facing PowerShell blocks parse.
- All 44 images checked with local Windows OCR: no configured real-name or known live-GUID matches. Staged secret
  scan clean; 656 tracked text files checked against eight known live IDs, with a deliberate leak rejected.
- Reviewed source: `cae4567`. Public release 10: `2f84715`; CI passes on Node 22 and 26, including every tracked
  Bicep template ([run](https://github.com/naveenneog/CCOF/actions/runs/40096140727)). Remote tree verified:
  44 evidence images, zero old live captures.
- Temporary client home removed and the session-owned capture browser stopped. The demo lab was retained and
  remains billable; no Azure resources were changed during recovery.
- Publication retained the hypothetical Lab A aliases in the new reader pages, evidence and capture-test fixture;
  the older real-tenant label substitution was excluded for those aliases. Other identifier rules still ran.

### G-GUARD — budget guard: projected spend, rate guard, 80% warning (2026-10-24)

- Owner: "throttling the user when he is at 80% of his usage notify him ... 15 percent overshoot is too much".
  Reconciler projects hidden spend (last 5 minutes x projection minutes), always limits the rate to the overshoot
  percent of the budget per projection window, warns and slows from the warn percent ([ADR-0040](adr/0040-budget-guard.md)).
  `/usage` and the status line show the warning. Settings `reconciler.budgetGuard` (example 80 / 5 / 5), Stage 5,
  quickstart Bicep and Core D2 parity.
- Tests: guard 5 (mutants 4/4), settings 2, `/usage` 2, client 1, staged contract (467). Root 1201 pass.
- Live: USD 14 budget at 80.4%: warning shown at once; final USD 13.84 (-1.1%), against +12.5% recorded / +19.7%
  list before. Spend USD 2.59. Council round 2 all PASS. Public release 9: `5b82caa`, CI passes (Node 22, 26).
### G-LIMIT live acceptance (2026-10-24)

- New staged deployment from the guide, Stages 0–8 verified, lab subscription, resource group `lab-e2e-rg`
  (prefix `e2e1024`, own Foundry account, existing Entra registrations and two existing groups). Portal walkthrough:
  21 of 21 screens, masked captures (not published in the public repository).
- Through the gateway: 15 of 15 admission and bypass cases; family limit 429 (Beta Haiku, 20,000 TPM); higher-spend
  selection (Alpha at equal spend, Beta after Beta spent more; no fallback); USD 10 Alpha budget used up: exhausted at
  21:24:00 (USD 10.35 recorded), first refusal 21:24:25, final recorded USD 11.25, list-price USD 11.97 (USD 0.72 =
  streamed cache writes the ledger cannot see); 8 of 8 attempts after exhaustion refused or confined to Beta's budget.
  Total estimated spend USD 11.98 against the USD 10 authorised (in-flight overshoot of the test itself).
- Chargeback: `WBS ID` field name, a person's `WBS-1001.01`, suggestion, CSV column and value, in the deployed console.
- Fixed with tests: ledger GUID typing (group usage was never attributed, `d9b6978`); policy fragments for the 16 KB
  API policy limit (ADR-0039, `8773205`); Stage 1 null subnet (`3beb2bb`); BOM read, usage-policy comments, Stage 8
  JSON column (`8773205`); `/usage` rows classified `no-backend-call` in the ledger (`d9b6978`). Mutants: split 3/3 caught; RED shown for
  every other new test.
- Council: round 1 Coder BLOCK (fragment ID bounds), fixed; round 2 all PASS. Public release 8: `66ea82c`, public CI
  passes (Node 22 and 26). The lab stays deployed for inspection.
- Open: E2E-01 (backend 429 shown as unpriced in chargeback; owner decision). Report:
  [BUDGET-ACCEPTANCE-2026-10-23.md](status/BUDGET-ACCEPTANCE-2026-10-23.md).
### Owner acceptance request (2026-10-23)

- G-LIMIT: test model-family restrictions, overlapping memberships, higher-spend selection, exhaustion, streaming,
  retries and concurrent requests. Reproduce reviewed monetary-enforcement gaps without billing first. The authorized
  live consumption ceiling is USD 10 across this request, not USD 10 per scenario; requests need a conservative
  worst-case cost bound before being sent. Report reconciled usage separately from Marketplace billing.
- G-LABEL: an administrator can name the individual chargeback tag (for example WBS ID); the name is persisted,
  appears in tagging and filtering, and labels the column in downloaded chargeback reports. Existing API field
  names remain compatible.
- G-WALK: follow the staged guide with Playwright, record actual Portal prerequisites and deployment outcomes,
  capture sanitized screenshots, and fix unclear or incorrect steps. No writes to the protected checkout or its
  existing deployments. Missing access is a documented blocked step, never evidence of a successful deployment.
- Budget review found a dropped resolver monetary ceiling and streamed-cache undercounting. A strict dollar cap
  requires atomic worst-case reservations, not a token-rate setting; current reconciliation/cache behavior does not
  provide that guarantee. See G-L1 through G-L4 in [UNKNOWNS](UNKNOWNS.md).
- Current evidence: [budget acceptance](status/BUDGET-ACCEPTANCE-2026-10-23.md). Direct Foundry smoke and cold/warm
  streamed cache calls total USD 0.011476 at list rates; USD 10 was not consumed. Full gateway testing is blocked by
  developer-client sign-in/consent and the need to deploy this checkout separately from the existing shared labs.
- Corrections: monetary ceiling retained, zero refused, old cached decisions invalidated; complete-accounting opt-in
  for person and strict-group state. New tests: 67/67, eight mutations caught with baseline count preserved.
  A nonbillable concurrency experiment admitted all 20 requests against the same USD 9.90 snapshot: still no strict cap.
- G-LABEL: deployment-wide field name defaults to User tag, is editable as WBS ID, uses audited ETag-protected
  settings and labels CSV headings without changing machine keys. Focused 36/36, admin 166/166, seven mutations
  caught. Actual local UI/APIs with in-memory stores: Playwright 21 checks, persisted label, saved-tag assignment,
  filter and downloaded CSV verified; no outbound requests. Report telemetry in that browser run was a fixture,
  not live chargeback data. [ADR-0037](adr/0037-deployment-user-tag-label.md).
- Council: Architect, Coder and Security PASS; QA and UX PASS-WITH-NOTES on live validation. Separate security
  review PASS (95 focused tests). Local browser follow-up completed afterward; full Azure acceptance remains blocked.
- Validation: full root suite, strict root/admin typechecks, root/admin builds and packet gate pass. Staged
  configuration: 451 checks. The guide walkthrough checked four images, 16 anchors and 84 local links; seven
  PowerShell blocks parsed. Sanitized Portal sign-in and local admin screenshots are linked in the guide.
- Local implementation commits: G-LIMIT `7df518e`, G-LABEL `711b9f2`. Root Node results: 1,182 passed, six
  opt-in live tests skipped, zero failed. Those skips are not live deployment or spend acceptance.
- G-WALK documentation and evidence: `024cec6`. Public release 7: `c987d02`, identifier scan clean, gitleaks clean,
  scrubbed-tree tests and strict typecheck pass. Public CI passes on Node 22 and 26
  ([run](https://github.com/naveenneog/CCOF/actions/runs/39999794528)).

### G-HA — Cosmos DB redundancy and consistency (complete offline)

- Owner: "a cosmos with consistency model ... so its not a single point of failure". `stage1.cosmosLocations` (regions in
  failover order, `isZoneRedundant`), `stage1.cosmosConsistency`; two or more regions turn on service-managed failover;
  configuration checks and a Stage 1 read-back (Staged.Cosmos.ps1); the resolver
  reads in `COSMOS_PREFERRED_REGIONS` order, set by Stage 5. Example: two zone-redundant regions (`eastus2`,
  `centralus`), provisioned autoscale, Session. [ADR-0036](adr/0036-cosmos-redundancy-and-consistency.md), guide 2.6.
- Tests: staged 446 checks; network DNS 5 (the real network check against a fake `az`); resolver config and Cosmos
  options 26; root 1168 pass, 0 fail; strict typecheck 0. Mutants 16/16 caught (two first survived because one test
  broke two rules at once; it was split). Read-backs run on the live Lab A account and endpoint: a single-region
  configuration passes; a two-region one names the missing region, the failover setting and the DNS name.
- Council round 1: ARCHITECT, QA BLOCK (Stage 6 accepted a Cosmos endpoint without every regional DNS name); notes on
  the bounded-staleness read-back, capacity pairs and cost wording. Round 2: all PASS (QA note: executable test for the
  verify-mode check, added).
- Public release 5: `d4a73ff`, public CI passes (Node 22 and 26).
- Live (2026-10-23, Lab A, throwaway RG `ccof-g9-cosmosha-rg`, deleted): `eastus2` was refused with and without
  zone redundancy and zone-redundant `westus3` was refused (`ServiceUnavailable`, "high demand"); zone-redundant
  `centralus` plus `westus3` without zones deployed with service-managed failover and Session (a Cosmos-only Bicep file,
  not a full Stage 1 run). The Stage 1 read-back function, called directly, reported 0 problems for the matching
  configuration, "Cosmos has 1 region(s); the configuration has 2" for the partial account, and the zone mismatch when
  `westus3` was configured zone-redundant. A data-plane check of the resolver's preferred regions was not run: the
  account's public network access stayed `Disabled` after two `az cosmosdb update` calls, as a tenant policy that
  enforces it would cause. Guide 2.6 records the capacity steps. The full staged deployment with two regions still
  needs a new resource group.

### G-FIX — client restore and Graph grant fixes

- Local commit `3d4b16f`; public release 6 `baffea8`, CI passed on Node 22 and 26
  ([run](https://github.com/naveenneog/CCOF/actions/runs/39990743201)).
- `Restore-ClientSnapshot` now removes folders the installer created (for example `~/.claude/skills`) when they are
  empty, deepest first; a folder that now holds another file stays; a snapshot without `createdDirectories` (older
  format) still restores. Installer tests 39; mutants caught 2/2 (count equal to the baseline, one failure each).
- `Grant-SyncGraphPermissions.ps1 -Permissions A,B,C` under `pwsh -File` passed one string and failed with
  `app_role_missing` (found live in Lab A, plan-only). Comma lists are now split, trimmed and de-duplicated; a list
  with no names stops with `no_permissions`. Quickstart step tests 34. The plan-only rerun listed all three
  permissions. Initial apply was blocked by inactive PIM; after the owner activated the role, all three assignments
  were applied and verified. This did not grant Azure CLI access to the gateway's delegated developer scope.
- Council: UX BLOCK (guide 2.6 described a Stage 1 read-back and rerun scope the code does not have; imperative
  wording); Coder and QA notes (empty permission list, old-format snapshot). All fixed; Architect, Security PASS.

### G-USAGE — a person's own budget: `/usage` (complete offline; live blocked)

- Gateway `GET /ccof/me/usage` (operation `get-my-usage`, own policy without `<base />`, token checks byte-equal to
  the messages policy, only the token's `oid` sent, per-person `admission.usage`), resolver `POST /api/me/usage`
  (point reads only; group totals behind `RESOLVER_USAGE_GROUP_TOTALS`, absent = hidden), client `ccof-usage` and the
  Claude Code skill `/usage` with an opt-in status line. Stage 5 deploys and reads the operation back.
  [USAGE.md](USAGE.md), [ADR-0035](adr/0035-own-usage-through-the-gateway.md).
- Tests: resolver usage 13 + handler 7; gateway usage 9 (including compiled C# vectors); client 65 (usage 13);
  installer 37, including the generated command run in real PowerShell and real Git Bash; staged 408; root 1166 pass,
  0 fail; strict typecheck (`tsconfig.typecheck.json`, run by public CI) 0 errors, after fixing 9 test and type
  errors left by earlier packets. Mutants 28/28 caught. Negative control, run as a mutation (not a committed test):
  the unquoted backslash command form makes the real Git Bash test fail with the separator loss Claude Code documents.
- Council round 1: all five BLOCK (group spend and cap exposed beyond "remaining"; directory display names in the
  model's context; command not runnable under PowerShell; last month's group figure shown as current; state not
  matched to classification). Round 2: QA BLOCK on the strict typecheck, others PASS. Round 3: QA PASS-WITH-NOTES.
  All fixed with tests.
- Not changed: restore removes `SKILL.md` but leaves an empty `skills\usage` folder.
- Live: not run. Session `c9943014` deployed its own usage implementation from the protected `ccof-public-manual-update`
  checkout to both lab resource groups (`lab-stdv2-rg` Stage 7 at 17:16, `lab-shared-foundry-rg` at 17:48, and
  was still active at 18:29); deploying from here would overwrite that work. Needs the owner to choose a lab.
- Public release 4: `bc435de`, pushed; public CI (`public-source-ci`, Node 22 and 26) passes for the first time, the
  previous three releases failed on the strict typecheck fixed here.

### G-NAMES — staged user names setting (complete)

- `admin.userNamesEnabled` → `ADMIN_USER_NAMES_ENABLED` in Stage 5 (stage5-config.bicep);
  guide section 6.1 grants `User.Read.All` with the group permissions and cites the ~24-hour managed identity token
  cache. Staged 400 checks; the mutant (setting not passed) is caught; template builds offline (isolated az profile).

### G-PUB — public repository (complete)

- `https://github.com/naveenneog/CCOF` (public) holds one commit, `95f0b86`, made from this tree on the orphan
  branch `public-main`: lab tenant, subscription and resource names replaced by neutral labels (21 rules, 168 hits),
  and the 47 live-run screenshots that show lab resource names removed (`docs/images/staged`,
  `docs/images/staged-stdv2`, `docs/runbooks/images/staged-portal`). The 86 middle-masked Portal images stay.
- Checks on the public tree: identifier scan 0 hits; gitleaks 1 commit, 2 findings, both the known false positive
  `projectApi: "v1-compatible"`; root 1132 pass, admin 159, staged 398, resolver auth 36; gate PASS.
- Local `main` keeps the full history and is not pushed. A later release is made on `public-main`:
  `git checkout public-main; git checkout main -- .`, rerun the scrub script (kept outside the repository because it
  lists the lab names it removes), commit, push `public-main:main`.
- History up to `55b816f` remains public in `naveenneog/ccof-bicep`, with the lab names this scrub removed.
- Release 2 (2026-10-23): `eeff307` on `public-main`, pushed to `main`, carries precedence by spend (`7594b8a`).
  Identifier scan 0 hits; gitleaks only the known false positive; root 1137 pass; staged 398. The scrub's
  `git rm` had refused the re-checked-out images (staged files need `-f`); they were removed before the commit,
  and the script now uses `-f` and stops if any image path is still tracked or present.
- Release 3 (2026-10-23): `b72e527`, the user names setting and the Graph grant steps (`670c715`). The script
  removed the images itself; identifier scan 0; gitleaks no findings in the change; staged 400.

### G-TAG — user tags (complete, admin 3.4.0)

- Owner decision 2026-10-23: the chargeback ID is an individual user tag. Per-person tag and saved-tag list in
  `adminConfig` ([src/contracts/user-tags.ts](../src/contracts/user-tags.ts)); admin API `/api/user-tags`
  ([admin/src/user-tags.ts](../admin/src/user-tags.ts)); the sync copies a person's tag into their group
  memberships' `chargebackId` (group's own ID as default; an unreadable tag store keeps stored IDs;
  [src/sync/plan.ts](../src/sync/plan.ts)); the gateway trace, ledger, workbook and exports carry it unchanged.
  Developers view gains `userTag`; console: User tags page (pick a group member through Graph, identity and current
  tag shown, saved tags suggested), chargeback "User tag" filter with suggestions.
- Tests: root suite green (user tags 8, sync run 18); admin 157/157; offline Kusto checker 0 errors on the
  developers query (negative control 1). Mutants: 20 caught (admin API 10, sync/contract/report 9, paging 1);
  one equivalent mutant removed by deleting the redundant guard. Browser (Edge, demo): 15/15 checks in light, dark
  and 390 px, including a two-editor stale save refused; the only console entry is that intended 412.
- Live: Graph member listing not verified; the Lab A token now gets a Continuous Access Evaluation challenge
  (`TokenCreatedWithOutdatedPolicies`) and needs a fresh `az login`.
- Council round 1: ARCHITECT, CODER, QA, UX BLOCK (unbounded sync query; saved list written before the change record;
  edit re-read the ETag at save time; object-ID-only entry); SECURITY PASS. Round 2: QA (previous person's data
  could enable Save), UX (`suggestionSaved: false` not shown), SECURITY (members of any directory group listable)
  BLOCK. Round 3: all five PASS; ARCHITECT note: the sync reads every tag each run (O(tags)), watch RU before
  approaching 200,000. Admin 159/159; 24 mutants caught in total.

### G-PREC and G-REM — precedence by spend, removal as retirement (complete)

- Owner decisions 2026-10-23. Without a selector, a person in several groups gets the group where they have the
  higher month-to-date spend (the reconciler's `spentCcu` in their `budgetState` for that group, current UTC month;
  none counts as zero), then the lower priority; a tie or malformed priority is refused, a malformed spend is
  `budget_state_invalid` ([select-membership.ts](../src/resolver/select-membership.ts)). Console help and hints
  updated.
- Revision (critic review): the first version compared per-user budgets, which is not usage spend. It now reads
  spend; the membership field `perUserBudget` that only the budget rule used is removed from the sync.
- Removal is retirement: group retirement already matched project retirement; a test proves removal ignores
  the removal limits ([sync-group-documents.test.ts](../tests/sync-group-documents.test.ts)).
- Tests: precedence 15/15 (spend order, exact decimals of any length including 500 digits, earlier month, no state,
  missing-state winner refused, ties, exhausted winner refused, malformed spend, failed read, baseline candidate);
  sync: a leftover `perUserBudget` is rewritten away (with a no-write control); root 1137 pass, 0 fail. Mutants 7/7
  caught (one first survived and the baseline test was strengthened); negative controls for a digit cap, a float
  comparison and a comparison that ignores the old field.
- Council (spend version): round 1 ARCHITECT, CODER, QA BLOCK (30-digit cap could reject valid reconciler output;
  missing-state winner untested); round 2 BLOCK on a 400-character cap; round 3 all five PASS.
- Council (first version) round 1: CODER, QA BLOCK (priority above 10,000 could win); fixed with a test. ARCHITECT
  PASS-WITH-NOTES (rollout: bump `gateway.keyVersion`, recorded in ADR-0034), UX and SECURITY PASS.

### G-SEED — staged pilot as a group (complete)

- A staged `groups` entry with `"kind": "group"` has no project or classification (Staged.Groups.ps1).
  Stage 4 creates or finds its Entra group (key `group/<name or id>`; baseline keys unchanged), Stage 5 lists it in
  the workbook, and Stage 7 rechecks the group in Graph, seeds its group document and writes the client file for
  `client.group`. Stage 8 sends no selector and checks in the `ccof.usage.v1` trace that requests were charged to
  the pilot group. `registrySeed` ([registry-seed.ts](../src/sync/registry-seed.ts)) accepts active group documents
  checked by `readGroupRegistration`. The example pilot is `CCOF-PILOT01`.
- Tests: staged 398 checks (was 360); registry seed 67/67; root 1117 pass, 0 fail; quickstart client 19/19 (refactor
  guard); selection KQL 0 errors in the offline checker (negative control 1 error). Mutants 19/19 caught.
- Live (Lab A, read-only): Stage 0 with the new example configuration completed in 59 s.
- Council round 1: ARCHITECT, CODER, QA BLOCK (a group deleted after Stage 4 could be seeded permanently;
  `backendId` not checked for group entries; Stage 8 could pass on another group); UX PASS-WITH-NOTES; SECURITY PASS.
  Round 2: QA BLOCK (mixed selector/no-selector acceptance switched the check off), others PASS. Round 3: QA PASS.
  Each fix has a test and a mutant.

### G9 — live verification (partial, 2026-10-23, Lab A)

Isolated `AZURE_CONFIG_DIR` per tenant; no Azure or Entra resource was created or changed.

- Admin group directory ([group-directory.ts](../admin/src/group-directory.ts)) run against Microsoft Graph with a
  delegated token: search `ccof` returned 8 security groups; hyphenated (`CCOF-LAB1`, 2) and partial (`lab`, 4)
  terms matched; group read with `members/$count` returned the member count (1); unknown ID `not_found`; disabled
  flag `disabled`; negative control with an invalid token `permission_required` (Graph 401).
- Stage 0 with a configuration derived from the example (new keys included): a backend without deployments stopped
  with `verify_failed: backend laba lacks deployments` (negative); with `stage1.foundry.create: true` it completed
  and verified in 60 s (providers registered, Flex in eastus2, planned deployments listed).
- `stage5-config.bicep` builds with `ADMIN_GROUP_SEARCH_ENABLED` from `admin.groupSearchEnabled`.
- Not done: the admin identity's Graph grants (needs a Privileged Role Administrator); deploying the group-centric
  packages to a lab and gateway calls with group decisions, surfaces and chargeback ID (models are in Lab B, whose
  profile needs an interactive `az login`). The Lab A lab `lab-stdv2-rg` has no Claude deployments and
  its staged state is not in this checkout.

### G-DOC — staged deployment guide (complete)

- [STAGED-DEPLOYMENT-GUIDE.md](STAGED-DEPLOYMENT-GUIDE.md): roles per stage, network, Entra applications (the
  settings Stage 4 applies), Graph permissions per identity, Foundry; Cloud Shell setup; per stage the command,
  Portal workbook sections and success check; group onboarding; Graph grant helper; rollback. Linked from README
  and the staged runbook.
- Checks: 6/6 PowerShell blocks parse; every relative link and anchor resolves.
- Council (fact check against code): round 1 BLOCK with 8 errors (wrong state path `completed` for `stages`,
  `-Stage <n>` not runnable, Stage 6 `existing` described as creating the network, missing APIM NSG and
  Azure Monitor egress, Stage 6 WARNs presented as checked, timers described as always off, Stage 1 non-empty
  RG rule, cleanup deleting reused Entra objects) and 3 notes. All fixed against the cited code.

### G-STAGE — staged settings for groups (complete)

- `gateway.surfaceClients` (Stage 5 writes `entra.surfaceClients`, IDs lower-cased) and `admin.groupSearchEnabled`
  (`ADMIN_GROUP_SEARCH_ENABLED`) in the staged configuration (Staged.Application.ps1,
  stage5-config.bicep). Both default off.
- Tests: `tests/Test-StagedStages.ps1` 360/360. Mutants 4/4 caught.
- Council: CODER PASS; ARCHITECT, QA, SECURITY, UX PASS-WITH-NOTES. Notes: the staged path admits only the gateway
  app and Azure CLI, so only those can be mapped (documented); `groupSearchEnabled` is ignored without the admin
  app (documented); the admin Graph grants are manual (guide section 6.1); new checks are source-level.

### G8 — admin UI for groups (complete, admin 3.3.0)

- Groups page, four-step onboarding (Entra search, budget with auto-scale/cap estimate, access and models,
  cache suggestion with evidence, budget assistant), group detail (edit, retire), Chargeback IDs view and filter,
  Help topics ([ADMIN-V3.md](ADMIN-V3.md) 3.3.0).
- Tests: `admin/tests/ui-groups.test.ts` 7/7 (pure form logic); admin 144/144; build OK. Mutants 7/7 caught.
- Browser (Edge via Playwright, demo server): 18/18 checks in light, dark and 390 px; 0 console errors, 0 failed
  requests. The name fix was negative-tested. Script: session file `ui-groups-walk.py`.
- Council: round 1 ARCHITECT and SECURITY PASS; CODER, QA, UX PASS-WITH-NOTES (wrong name or member count after
  re-picking a group; the detail page overwrote the stored cache share; an invalid chargeback filter broke
  queries). Fixed. Round 2: two low notes (re-pick after Back, deep-link filter), fixed and walk-tested.

### G7b — export for Power BI (complete)

- `GET /api/v3/export/usage` (per chargeback ID, group and person; up to 5,000 rows) and `/api/v3/export/groups`
  (group configuration), JSON or CSV with formula-injection guard, truncation headers, and refusal of filters the
  export cannot apply ([admin/src/export.ts](../admin/src/export.ts), [ADMIN-API.md](ADMIN-API.md)).
- Tests: export 7/7; admin suite green. Mutants 13/13 caught (one equivalent mutant removed by simplifying the code).
- Council round 1: CODER BLOCK (`tags` accepted but ignored, so the export was unfiltered). Fixed with truncation
  headers and the explicit rate-card error. Round 2: ARCHITECT, CODER, QA PASS; SECURITY, UX PASS-WITH-NOTES.
- Power BI connector sign-in is unverified (G-R3); CSV/JSON download is the documented path.

### G7a — chargeback ID in usage and workbook (complete)

- Gateway validates and caches the decision's `chargebackId`; the `ccof.usage.v1` trace carries `chargebackId`
  and `surface`; `ledger.kql` exposes both (validated); the workbook and console gain `chargebackIds`
  (chargeback ID by developer, `(none)` when absent); the console filters with `chargeback=`.
  [CHARGEBACK.md](CHARGEBACK.md), [GATEWAY.md](GATEWAY.md).
- Tests: gateway 134/134 (compiled C#), workbook/chargeback suites, admin 131/131; offline KQL checker 0 errors
  on 23 workbook and admin queries (checker shown to fail on a broken query). Full gate PASS.
- Mutants: 10/10 caught. Workbook digests and the quickstart table count updated deliberately.
- Council round 1: CODER and QA BLOCK (`chargebackIds` unreachable through the v3 route). Fixed with a
  route-level test. Round 2: all five PASS.

### G6 — admin group API (complete)

- `/api/groups` list, read, onboard, update (If-Match), retire (confirm ID); Entra group search and member
  count via Graph `Group.ReadBasic.All` and `GroupMember.ReadBasic.All` behind `ADMIN_GROUP_SEARCH_ENABLED`;
  cache suggestion route ([admin/src/groups.ts](../admin/src/groups.ts),
  [admin/src/group-directory.ts](../admin/src/group-directory.ts), [ADMIN-API.md](ADMIN-API.md)).
- The projects API and V2/V3 project lists exclude group documents.
- Tests: admin 129/129, build OK. Mutants 17/17 caught after fixing two vacuous tests.
- Council round 1: ARCHITECT BLOCK (group documents listed as projects; the V3 project page crashed on
  one). Fixed server-side. Round 2: ARCHITECT, CODER, QA, SECURITY, UX PASS.
- Not live-verified: Graph permissions are not granted in any tenant yet (G9).

### G4 — surfaces (complete)

- Gateway setting `entra.surfaceClients` maps admitted client apps (token `azp`/`appid`) to a surface;
  empty means not enforced ([gateway-config.schema.json](../infra/gateway/gateway-config.schema.json),
  [config.ts](../infra/gateway/config.ts)). The policy requires valid `surfaces` on `group` decisions and
  refuses 403 `surface_not_allowed` before any token counter ([claude-messages.template.xml](../infra/gateway/policy/claude-messages.template.xml)).
  Quickstart, Core and manual producers emit an empty list. [GATEWAY.md](GATEWAY.md) documents it.
- Tests: gateway suites 133/133 (vectors run as compiled C#); full packet gate PASS (all PowerShell suites).
- Mutants: 10/10 caught after adding a structural refusal-wiring test and fixing a duplicate-mapping
  test that the schema short-circuited.
- Council: ARCHITECT PASS-WITH-NOTES (deploy the resolver before the policy), CODER PASS, QA PASS,
  SECURITY PASS-WITH-NOTES (one re-resolve per group user at rollout), UX PASS.
- Follow-up: quickstart inputs do not expose `surfaceClients`; the staged configuration does (G-STAGE).

### G5 — cache suggesters (complete)

- [src/contracts/cache-suggestions.ts](../src/contracts/cache-suggestions.ts): per-surface suggestion with evidence
  class (illustrative, analogue, assumed, none) and source; a group's suggestion is the lowest among
  enabled surfaces the gateway carries, returned with the surfaces and classes that set it.
- Tests: `tests/cache-suggestions.test.ts` 6/6. Mutants 5/5 caught.
- Council round 1: labels overstated evidence (`code` marked published; `cowork` used a tuned figure).
  Fixed. Round 2: ARCHITECT and UX PASS-WITH-NOTES (cowork, not gateway-routed, set the minimum:
  now excluded), CODER PASS, QA PASS-WITH-NOTES, SECURITY PASS.

### G3 — precedence (complete)

- No selector and all active memberships are groups: the lowest `priority` applies; ties, malformed
  priorities and baseline candidates keep `project_selection_required`; an exhausted lowest-priority
  group is refused, not skipped ([src/resolver/select-membership.ts](../src/resolver/select-membership.ts)).
- Tests: `tests/resolver-group-precedence.test.ts` 7/7; resolver suites 284 pass, 2 skipped (live).
- Mutants: 3/3 caught.
- Council: ARCHITECT PASS, CODER PASS, QA PASS-WITH-NOTES (two cases added), SECURITY PASS; UX not
  applicable. G-A1 remains ASSUMED pending owner confirmation.

### G2b — resolver and gateway carry group attributes (complete)

- `validateMembership` reads group attributes only under the code `group` and checks the family
  policy with the approval ([src/resolver/freshness.ts](../src/resolver/freshness.ts)); the decision
  returns `surfaces`, `chargebackId`, `restrictedFamiliesApproved` for groups only
  ([src/resolver/decide.ts](../src/resolver/decide.ts)). APIM admits Fable/Mythos for `CYB` or an
  approved group at the fresh, cached and per-request checks
  ([claude-messages.template.xml](../infra/gateway/policy/claude-messages.template.xml)).
- Tests: `tests/resolver-group-membership.test.ts` 4/4; resolver suites 279 pass, 2 skipped (live);
  gateway suites 124/124 with the vectors run as compiled C#.
- Mutants: 9/9 caught (resolver 4, policy 5; one policy mutant first caught only by the structural
  cached/fresh equality test, then confirmed behaviourally by the non-boolean vector).
- Council: ARCHITECT PASS-WITH-NOTES (revocation follows the cache TTL, as for CYB), CODER PASS,
  QA PASS-WITH-NOTES, SECURITY PASS-WITH-NOTES (validate surfaces/chargeback ID in APIM before G4/G7
  use them); UX not applicable.

Open unknowns for the work stream: G-A1 to G-A4, G-R3 ([UNKNOWNS](UNKNOWNS.md)).

## Admin V3 user names

**Completed packet:** V3-names — complete: Admin 3.1.0 displays current Entra names beside full object
IDs. Only admin code/package changed; no gateway, sync or reconciler code, config or deployment.
Manual upgrade: [VDI procedure](ADMIN-V3-VDI-UPGRADE.md); new permission: admin managed identity
Graph application `User.Read.All`, consent, `ADMIN_USER_NAMES_ENABLED=true`.

Evidence:
- 108 admin tests and the admin build pass. Package inspected for admin entry points/UI/KQL.
- Edge demo: names/full IDs on Overview, Developers, Budgets, Reconciler, Audit and Project Activity;
  Light/Dark/mobile; denied/disabled/unavailable/missing users retain IDs and cost figures.
- Integrated server/browser cache tests cover original expiry, clock skew, cache bounds, stalled
  requests and queue recovery. Provider errors are sanitized, with no names/UPNs in logs.
- Five PowerShell guide blocks parse; local links resolve; no guide commands were executed.
- Council: ARCHITECT PASS, CODER PASS, QA PASS, SECURITY PASS (independent reviewers);
  UX PASS (browser checks). Review found layered TTL and stalled-request edge cases; regression
  tests reproduced them before the fixes.
- Repository packet gate passes; existing file-size warnings remain.

Implementation commit: `41c2c2e`. The local ZIP is `ccof-admin-v3.1.0.zip` in this session's files
(SHA-256 `f25438c857b7058ec9bdc8b55c48491dc9d33b2e7f27fa1e0ce472a90e857554`).
No live directory lookup, customer deployment or Graph permission change was performed.

## Standard v2 and Foundry, two tenants (S3, complete with open items)

Verified 2026-10-20 in Lab B and Lab A ([report](archive/STAGED-STDV2-RUNS-2026-10-20.md)).
Open: Portal walkthrough screenshots need a persistent Portal sign-in; Graph application consent
needs PIM activation in Lab A; Claude in Lab A needs a non-sandbox subscription.


## Staged deployment, stages 0-8

**Completed packet:** S2 — staged entry points for stages 2-8 and a live end-to-end run.

Status: verified, 2026-10-20, in the new lab RG `lab-staged-rg`
([report](archive/STAGED-LIVE-RUN-2026-10-20.md)). The Stage 1 RG below was deleted first.

Open items:

- Private-only variant (StandardV2 APIM with VNet integration, private Function endpoints,
  in-network build agent) not run.
- New Entra registrations/groups not exercised (operator directory quota); merge path verified.
- Least-privilege identity per stage, timers, load and 10,000-project scale not tested.
- Admin console shows sub-cent costs as $0.00.


## Stage 1 resources-only live proof

**Completed packet:** S1 — Stage 1 resources-only live proof.

Status: verified, 2026-10-20. No later-stage deployment is active.

Acceptance:

- `infra/staged/main.bicep` and both parameter examples compile.
- Recursive template checks reject network attachments, role assignments, schema,
  application settings and code deployment.
- A new, empty lab resource group receives only the approved resource inventory.
- Live read-back verifies private/keyless settings and identity outputs; an ARM
  success is not runtime acceptance.
- The runbook states operator permissions, inputs, outputs, recovery and deferred work.

Source baseline: `b116f63`. Scope is Stage 1 only. Existing lab/customer resources,
Entra, application packages and permission assignments are outside the write boundary.

See [unknowns](UNKNOWNS.md) and [roadmap](ROADMAP.md).

## Evidence

- Azure deployment `stage1-proof` in the new lab RG succeeded.
- Read-back passed for all four services, private/keyless controls and the
  absence of application settings, schema and grants.
- The existing Bicep templates needed no provider-driven changes.
- A valid forbidden-role fixture was rejected by the existing contract test.
- `node .ironclad/gate.mjs --stage packet --json`: exit 0; full root tests,
  type-check and build pass. The pre-existing file-size warning remains.
- Admin build and all 95 tests pass.
- New runbook's three PowerShell blocks parse and local documentation links resolve.

Detailed [live report](archive/STAGE1-LIVE-VERIFICATION.md) and
[commands/permissions](runbooks/STAGED-DEPLOYMENT-V2.md).
This packet's commit is the Git change containing this status file.
