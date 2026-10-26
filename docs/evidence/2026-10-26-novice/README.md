# Novice walkthrough, 2026-10-26

A third first-time deployment, from `main` after the long-term audit merge: the README, the five
[get-started](../../get-started/01-what-it-is.md) pages, and the [audit archive](../../operate/audit-archive.md) and
[chargeback history](../../operate/chargeback-history.md) pages they link to, with both audit features on. Each
failure was recorded as it appeared, then fixed in the code or the guide. The `fail-*` images show the output before
the fix; the `fix-*` images show what the reader sees now; the `ok-*` images show the checks that passed.

Names and identifiers in the images are hypothetical, in the same format as the
[2026-10-24 demo](../2026-10-24-demo/README.md). Lab resource names (`ccofnv3-…`) are real; they hold no secret.
Previous run: [2026-10-25](../2026-10-25-novice/README.md).

## Route

| Item | Value |
| --- | --- |
| Pages | README -> 01 -> 02 -> 03 (with configuration, identity and audit reference) -> 05; operate: audit archive, chargeback history |
| Subscription, region | One subscription, `eastus2`, `network.mode: create` |
| Identity | Existing gateway and resolver registrations (`entra.existing`); a new admin registration for this lab (row 2); one existing group (`groupId`) |
| Choices off the template | The lab column of the Stage 1 table on the deploy page; `claude-haiku-5-5` and `claude-sonnet-5-5`, `DataZoneStandard`, 20 each; `budget-state`, `reconciler.timerEnabled: true`, USD 100 per person; `azure-cli` sign-in; `audit.chargebackHistory.enabled: true`; the Azure CLI client in `admin.extraAllowedClientIds` (chargeback history page) |
| Attempts | One. Stage 1 waited about 12 minutes for model quota held by deleted labs (row 1) |

## What failed, and what changed

| # | Stage | What the reader saw | Cause | Now | Image |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | `stage 0 completed and verified in 53 s` with two planned deployments of capacity 20, while 7 of 27 `DataZoneStandard` units of `claude-haiku-5-5` were free | Stage 0 checked the model, version and `sku`, not the free quota; deleted Foundry accounts of removed labs still held 20 units. The shortfall would have appeared only in the Stage 1 apply | Stage 0 refuses: `model quota in eastus2: deployment claude-haiku-5-5 needs 20 of AIServices.DataZoneStandard.claude-haiku-5-5.Azure; 7 free (20 of 27 used)`, with the purge commands | `fail-01-stage0-passes-without-quota.png`, `fix-01-stage0-refuses-quota-shortfall.png` |
| 2 | 4 | The preview for three reused registrations printed only the general plan (`preview: admin app: … SPA redirects /api/console and /api/console-v3 …`) | Whether the apply would change a shared registration could be found only by reading it by hand. It would have added two redirect URIs to a shared admin registration, so this lab used a new admin registration instead (Stage 5 refuses to start before Stage 4: `stage_order`) | The preview prints, per reused registration, what the apply adds, or `no change` | `fail-02-stage4-preview-generic.png`, `fix-02-stage4-preview-names-changes.png` |
| 3 | Audit | Downloading a month from the chargeback history page: `Invalid URI: The hostname could not be parsed.` | Azure CLI 2.91.0 returns `az functionapp show` in the resource (ARM) shape; `--query defaultHostName` printed nothing | The page queries `properties.defaultHostName \|\| defaultHostName`; the current month returns `200` (JSON and CSV), the previous month `409 history_not_covered` | `fail-03-history-download-empty-host.png`, `fix-03-history-download-200-and-409.png` |
| 4 | Developer | `claude -p "/usage"` printed nothing; its JSON result shows `"local_command":"usage"` | Claude Code 2.1.272 answered with its own `/usage` command in print mode, not the CCOF skill of the same name. The skill itself works (`ok-03`) | Open: the interactive `/usage` was not checked in this unattended run | `fail-04-usage-slash-runs-builtin.png` |

## Stage timings

| Stage | Preview | Apply | Notes |
| --- | --- | --- | --- |
| 0 | — | 53 s, 52 s | Second run after the deleted accounts were purged |
| 1 | 3 s | 368 s | |
| 2 | 28 s | 229 s | `stage2.verify.json` lists `chargebackDaily` |
| 3 | 28 s | 465 s | |
| 4 | 13 s | 54 s | Row 2 |
| 5 | 45 s | 124 s | Both `audit archive:` lines; `network public-disabled (policy or private)`: a storage policy turned public access off (`ok-05-stage5-archive-lines.png`) |
| 6 | 30 s | 790 s | |
| 7 | 6 s | 1,354 s | `"outcome":"succeeded"`, `"membersAdmitted":1`, `"writeFailures":0` |
| 8 | 3 s | 290 s | Anonymous `401`, `claude-haiku-5-5` `200` (`STAGED OK`), `claude-opus-5-5` `403`, admin console `200`, one ledger row charged to the group |

Applies took 62 minutes in total; waiting for quota added about 12 minutes.

## Success run

- **Developer setup** ([page 5](../../get-started/05-developer-setup.md)) in a scratch user profile: setup printed
  `"signInMethod":"azure-cli"` and the `"signIn"` command (`ok-01-developer-setup-azure-cli.png`); `claude -p` answered
  through the gateway (`ok-02-claude-through-gateway.png`, with the model-catalog notice CC-01); the usage skill
  printed USD 0.00 of USD 100.00 (`ok-03-usage-skill-budget.png`). The interactive sign-in window was not opened: the
  helper's profile folder received a copy of an Azure CLI profile already signed in to the same tenant.
- **Audit archive**: storage metrics show Azure Monitor's `PutBlob` and `AppendBlock` writes with `OAuth` within
  minutes of the Stage 8 requests (`ok-04-archive-delivery-metrics.png`).
- **Chargeback history**: reconciler run lines `historyOutcome: written`, one with `historyWritten: 1` after the
  requests (`ok-06-history-run-lines.png`; the page's query, sent through the Log Analytics query API). Export:
  row 3.

## Open items

- Row 4: whether the interactive `/usage` in Claude Code 2.1.272 shows the CCOF budget or Claude Code's own command.
- The Claude Code model-catalog notice for `claude-haiku-5-5` (CC-01 in [UNKNOWNS](../../UNKNOWNS.md)).
- An export answered from history (`sources`), possible from 1 November, when October is the previous month.
- Smaller hesitations, not changed: the template's `deploymentInferenceGeo` names `claude-opus-5-5`, which Stage 0
  refuses unless deployed; Stage 7 prints the admin package's test lines between the `Deploying` and `Built` lines.

## Rating from a first-time reader

| | Before this run's fixes | After |
| --- | --- | --- |
| Reaching a working deployment from the README alone | 7/10: every stage passed first time, but Stage 0 passed a quota that would have failed Stage 1, and reusing shared registrations needed a hand-made comparison | 8/10: Stage 0 refuses the quota shortfall and names the purge, and the Stage 4 preview shows each change to a reused registration |
| Developer sign-in | 8/10: one setup command and one sign-in command; `/usage` in print mode answered with Claude Code's own command | 8/10: unchanged; row 4 is open |
| Audit (archive and history) | 6/10: the archive and history checks worked as written, but the old-month download failed on the current Azure CLI | 8/10: the download returns `200` and `409 history_not_covered` as the page says |
| Remaining | Row 4; CC-01; the history-sourced export after 1 November | |
