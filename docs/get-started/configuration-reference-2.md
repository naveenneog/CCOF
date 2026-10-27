# Configuration reference: Entra, groups, client

Part of the [configuration reference](configuration.md). Every key of these sections in
[staged.config.example.json](../../infra/staged/staged.config.example.json), with the columns of the
[first reference page](configuration-reference.md): **Req**, **Template**, allowed values and effect, and the code that
reads the key.

## Entra

Forms: [Entra applications](configuration-identity.md#entra-applications).

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `entra.gatewayAppDisplayName` | No | `CCOF Gateway` | Name looked up or created when `entra.existing.gatewayAppId` is absent; letters, digits, space, `. _ -` | `Resolve-StgApp` |
| `entra.resolverAppDisplayName` | No | `CCOF Resolver API` | Same, for the resolver | `Resolve-StgApp` |
| `entra.adminAppDisplayName` | No | `CCOF Admin` | Same, for the admin console | `Resolve-StgApp` |
| `entra.existing.gatewayAppId` | No | absent | Application (client) ID GUID of a gateway registration to reuse | `Read-StgConfig`, `Resolve-StgApp` |
| `entra.existing.resolverAppId` | No | absent | GUID of a resolver registration to reuse | as above |
| `entra.existing.adminAppId` | No | absent | GUID of an admin registration to reuse; read when `stage1.includeAdmin` is `true` | as above |
| `entra.allowAzureCliClient` | No | `false` | `true` preauthorizes the Azure CLI client on the gateway app; needed for `client.signInMethod: azure-cli` | Stage 4 |
| `entra.adminEditors[]` | If new admin app | `@me` | Object IDs, or `@me`; receive `CCOF.Projects.Write` | Stage 4, `Read-StgConfig` |
| `entra.adminReaders` | No | `[]` | Object IDs; receive `CCOF.Projects.Read` | Stage 4 |

## Groups

Forms: [Groups](configuration-identity.md#groups). Contract: [group-registration.ts](../../src/contracts/group-registration.ts).
`groups[].budget` holds the keys `mode`, `perUser` and `groupCap` and `groups[].familyPolicy` holds `aggregateLimits` and
`families`; each leaf is a row below.

`groups[]` seeds a group once: Stage 7 creates its document and never replaces it (create-only, ADR-0024). Afterwards
the admin console owns the group. To change an existing group, change it in the console; editing its `groups[]` entry
does not apply. When a Stage 7 rerun finds a group document that differs from its entry (edited in the console), it
stops with `seed_documents_differ`, naming each group and the differing fields. Set `stage7.keepDifferingGroups: true`
to keep the console's version and continue; Stage 7 then prints `kept N console-edited group(s): …` last and records
the kept groups in `evidence/stage7.verify.json` (`seed.kept`). Other differing documents always stop Stage 7
([Staged.Groups.ps1](../../infra/staged/Staged.Groups.ps1) `Invoke-StgSeed`).

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `groups[].kind` | Yes | `group` | `group` | `Test-StgGroupEntry` |
| `groups[].groupId` | One of the two | absent | Object ID of an existing security group | Stage 0, Stage 4 |
| `groups[].groupDisplayName` | One of the two | `CCOF-PILOT01` | Group created or reused by name; letters, digits, space, `. _ -` | Stage 4 |
| `groups[].members[]` | No | `@me` | Object IDs, or `@me`; added to the group when missing | Stage 4 |
| `groups[].displayName` | Yes | `Pilot 01` | Name shown in the admin console | `Staged.Groups.ps1` |
| `groups[].backendId` | Yes | `REPLACE-backend-id` | Equals a `backends[].id` | `Get-StgGroupEntryProblems` |
| `groups[].priority` | Yes | `100` | Whole number 1-10000 | `group-registration.ts` |
| `groups[].chargebackId` | No | `null` | Cost-center label, or `null` | `group-registration.ts` |
| `groups[].budget.mode` | Yes | `autoScale` | `autoScale` (with `groupCap: null`) or `cap` | `group-registration.ts` |
| `groups[].budget.perUser.amount` | Yes | `25000` | Number; `25000` `CCU` is a compute-unit amount, `100` `USD` a dollar amount | `group-registration.ts`, reconciler |
| `groups[].budget.perUser.currency` | Yes | `CCU` | Currency code; `USD` for dollar budgets | as above |
| `groups[].budget.perUser.period` | Yes | `monthly` | Budget period | as above |
| `groups[].budget.groupCap` | Yes | `null` | `null` with `autoScale`; an amount with `cap` | `group-registration.ts` |
| `groups[].restrictedFamiliesApproved` | No | `false` | `true` is required to list `fable` or `mythos` families | `model-families.ts` |
| `groups[].familyPolicy.aggregateLimits.person.tokensPerMinute` | No | `200000` | Whole number or `null` | `model-families.ts` |
| `groups[].familyPolicy.aggregateLimits.person.tokenQuota` | No | `500000` | Whole number or `null` | as above |
| `groups[].familyPolicy.aggregateLimits.person.tokenQuotaPeriod` | No | `Daily` | `Hourly`, `Daily`, `Weekly`, `Monthly`, `Yearly`, or `null` | as above |
| `groups[].familyPolicy.aggregateLimits.group.tokensPerMinute` | No | `null` | As for `person` | as above |
| `groups[].familyPolicy.aggregateLimits.group.tokenQuota` | No | `2000000` | As for `person` | as above |
| `groups[].familyPolicy.aggregateLimits.group.tokenQuotaPeriod` | No | `Daily` | As for `person` | as above |
| `groups[].familyPolicy.families.<family>.models[]` | Yes | `claude-haiku-4-5` | Deployment names of the family; `<family>` is `haiku`, `sonnet`, `opus`, `fable` or `mythos`; a model outside every family is refused (403) | `model-families.ts` |
| `groups[].familyPolicy.families.<family>.person.tokensPerMinute` | No | `null` | Per-family limit for a person; `null` for none | as above |
| `groups[].familyPolicy.families.<family>.person.tokenQuota` | No | `null` | As above | as above |
| `groups[].familyPolicy.families.<family>.person.tokenQuotaPeriod` | No | `null` | As for `aggregateLimits` | as above |
| `groups[].familyPolicy.families.<family>.group.tokensPerMinute` | No | `null` | Per-family limit for the group | as above |
| `groups[].familyPolicy.families.<family>.group.tokenQuota` | No | `null` | As above | as above |
| `groups[].familyPolicy.families.<family>.group.tokenQuotaPeriod` | No | `null` | As for `aggregateLimits` | as above |
| `groups[].surfaces[]` | Yes | `code` | `chat`, `code`, `cowork`, `design`, `m365` | `group-registration.ts` |
| `groups[].cacheProfile.expectedCacheReadPercent` | Yes | `85` | Number 0-100 | `group-registration.ts` |
| `groups[].cacheProfile.basis` | Yes | `suggested` | `suggested` or `custom` | `group-registration.ts` |
| `stage7.keepDifferingGroups` | No | absent | `true`: a Stage 7 rerun keeps group documents edited in the admin console; absent or `false`: it stops with `seed_documents_differ`. Part of the Stage 7 hash only when present | `Invoke-StgSeed`, `Get-StgStage7Problems` |

## Client

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `client.group` | Yes | `CCOF-PILOT01` | One `groups[]` entry, by `groupDisplayName` or `groupId` | `Staged.Groups.ps1` |
| `client.signInMethod` | No | `msal` | `msal` or `azure-cli`; `azure-cli` needs `entra.allowAzureCliClient: true` | `Assert-StgClientSignInMethod` |
| `client.models.default` | Yes | `claude-sonnet-5` | Deployment name Claude Code uses by default | Stage 0, Stage 7 |
| `client.models.sonnet` | Yes | `claude-sonnet-5` | Deployment name for the Sonnet alias | Stage 0, Stage 7 |
| `client.models.haiku` | Yes | `claude-haiku-4-5` | Deployment name for the Haiku alias | Stage 0, Stage 7 |
| `client.models.opus` | Yes | `claude-sonnet-5` | Deployment name for the Opus alias | Stage 0, Stage 7 |

Stage 0 and the Stage 7 preview/apply reject invalid aliases **before publishing anything**. Each value must be
an exact, case-sensitive deployment name in both the selected group's family policy and its backend's
`deploymentInferenceGeo`. The error lists the configured aliases and admitted names; client export checks again.
For a Haiku-only backend, point all four aliases at that Haiku deployment. Alias labels do not deploy models or
grant access to another family.

Next: [resolver, sync, gateway and reports](configuration-reference-3.md).
