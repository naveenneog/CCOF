# Deployment-day screens

Real terminal output and read-only console captures, prepared on the night of 2026-10-27/28.
**All identities, GUIDs and resource names are hypothetical replacements.** The private mapping/evidence is
not shipped. Terminal screenshots are rendered from the adjacent `.txt` excerpts, not photographs of a terminal.
Preview and apply excerpts share a screen where they differ. Durations are measured **successful applies**;
previews were not separately timed in this HA run. Planning allowances in the guide are not measured guarantees.

## Capture inventory

| Image | Source run/date | Time and interpretation |
| --- | --- | --- |
| [Stage 0](stage-0.png) | Central India HA lab, 2026-10-27, preflight after approved Cosmos fallback | 74 s; read-only, no apply |
| [Stage 1](stage-1.png) | Same HA run; guarded preview and approved fallback apply | 538 s; APIM/Functions/storage zonal, **Cosmos nonzonal**, not full zonal Cosmos proof |
| [Stage 2](stage-2.png) | Same HA run, final preview/apply | 259 s |
| [Stage 3](stage-3.png) | Same HA run, final preview/apply | 845 s |
| [Stage 4](stage-4.png) | Same HA run, final preview/apply | 63 s printed (state records 62 s); existing shared gateway/resolver reused with no change |
| [Stage 5](stage-5.png) | Same HA run, final preview/apply | 119 s |
| [Stage 6](stage-6.png) | Same HA run, final preview/apply | 879 s |
| [Stage 7](stage-7.png) | Same HA run, second preview/apply | 1,286 s; first attempt's client-alias refusal is not hidden by this successful retry |
| [Stage 8](stage-8.png) | Same HA run, final preview/apply | 296 s; earlier single-group acceptance, **not tonight's three-developer proof** |
| [Developer setup](developer-setup.png) | Central India novice lab, 2026-10-27, recorded setup output | Setup not timed; associated model probe 15 s |
| [Two-group onboarding](two-group-onboarding.png) | Tonight's live Central India HA lab, 2026-10-27 | POST 201 in 0.271 s; snapshot server run 561 ms; explicit calls 200 in 3.845/2.075 s, denied model 403 in 0.146 s; default 200 in 2.786 s after upstream-error retries |
| [Usage and status line](usage-and-status.png) | Usage-skill response: novice lab, 2026-10-26; wrapper/status line: Central India novice lab, 2026-10-27 | Both real earlier captures, combined and rerendered; not timed. No new interactive `/usage` run is claimed |
| [Groups list](console-groups.png) | **Live group-only rehearsal console**, merged release-22 source, 2026-10-28 | Two active groups; no Legacy projects navigation; not timed |
| [Onboarding form](console-onboard.png) | Same rehearsal console/API | Form only; no extra group submitted; not timed |
| [Group detail](console-group-detail.png) | Same rehearsal console/API | Data Science's actual **USD 1** lab budget, not the guide's illustrative USD 50; not timed |
| [Budgets snapshots](console-budgets.png) | Same rehearsal console/API | Two group/two person budgets; both actual snapshot links open the correct group, snapshots current; Engineering's native stream remains partial; not timed |
| [Chargeback by group](console-chargeback.png) | Same rehearsal console/API | Both groups' actual telemetry; tiny known costs round to USD 0.00. Engineering's incomplete cost stays absent with a partial/lower-bound warning; not timed |

## Authentication and proof boundary

The five console screenshots replace earlier release-21 HA-console captures which still showed Legacy projects.
They now come from the **actual live rehearsal deployment's group-only console**, published by its Stage 7,
then admin-only refreshed from the final release-22 source after its merge from `main`.
These are not localhost, a locally substituted UI bundle or synthetic fixtures. Both actual snapshot links were clicked
and opened the correct group pages. This capture automation performed no state-changing writes.
The final release-22 group-only build retains the User tags sidebar; it was not hidden or edited out.

To avoid an unattended interactive sign-in, capture
automation changes **only that browser's fetched sign-in configuration** to demo mode and injects the approved
Azure CLI admin token into API requests. API authorization remains real; no API data is mocked and no state-changing
write is sent (read-only planner/name lookup POSTs are allowed). This is not an interactive MSAL sign-in test, and the displayed demo-editor label
reflects that substitution, not a fake live token or production bypass.

The terminal images above retain their original HA-lab provenance. The new rehearsal console also has two APIM
units and its separately approved nonzonal two-region Cosmos fallback. It uses USD 1 lab budgets for both groups.
Its successful explicit/default requests and priced rows do not establish service reliability or full-population
capacity; earlier HA-lab probes encountered 408/500 failures.
Only one developer identity was available. Three developers and an Intune/Office/Cowork/native Desktop pilot
remain separate acceptance work.

## Capture checks

- Repository `pseudonymise.cjs` and the existing novice mapping, extended with this lab's names, replace real
  values and refuse a capture when mapped real values/leak tokens remain.
- Each terminal text passes that check and the deployment packet's identifier/name leak scan **before**
  `render-terminal.py` creates its PNG.
- Each browser screenshot goes through `capturePseudonymised`, which checks text, form values, titles and ARIA
  labels in every frame before writing the image. Visible browser text is saved alongside it.
- All images are visually inspected before commit. No token, cache, real resource URL, account name or app/user
  ID belongs in this directory. The private raw logs/results retain exact operational outputs.

Reader route: [deployment day](../../get-started/deployment-day.md) ·
[configuration](../../get-started/deployment-day-config.md) · [developer clients](../../get-started/deployment-day-users.md).
