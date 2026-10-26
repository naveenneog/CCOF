# ADR-0050: Import downloaded client configuration

Status: Accepted (2026-10-27). Finding: DG-1.

## Context

Setup pinned the downloaded JSON's location in installed helpers and stored the Azure CLI
profile beside it. Download cleanup broke usage; synced download folders could contain sign-in
state. [ADR-0048](0048-claude-code-setup-on-macos-and-linux.md) already defines per-user folders.

## Decision

The Code and Desktop setup entrypoints validate the supplied configuration, then copy its
original contents into the platform's per-user `ClaudeGateway/config.json`, independent of
`CCOF_CONFIG_FILE`. Installed settings use this copy; default backups and the CLI profile
remain alongside it. Explicit `-BackupRoot` still overrides backup placement. Reruns with the
installed file do not copy it onto itself. Invalid input never replaces an installed file.

Keeping downloads permanently was rejected: it preserves a fragile dependency and places
sign-in state in an unexpected folder.

## Consequences

One current configuration per OS user, as with the existing setup default. Reinstalling for
another gateway replaces this configuration. Client-settings restore does not restore the
configuration or migrate/delete a pre-existing download-folder CLI profile; sign in again
using the new helper, then remove any old profile through the approved device-cleanup process.

Source: [setup common functions](../../scripts/client/ClientGateway.Common.ps1).
