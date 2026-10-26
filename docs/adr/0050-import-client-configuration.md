# ADR-0050: Import downloaded client configuration

Status: Accepted (2026-10-27). Finding: DG-1.

## Context

Setup pinned the downloaded JSON's location in installed helpers and stored the Azure CLI
profile beside it. Download cleanup broke usage; synced download folders could contain sign-in
state. [ADR-0048](0048-claude-code-setup-on-macos-and-linux.md) already defines per-user folders.

## Decision

The Code and Desktop setup entrypoints finish installed-client and configuration/settings/schema
preflight checks before publishing validated configuration into the platform's per-user
`ClaudeGateway/config.json`, independent of
`CCOF_CONFIG_FILE`. Installed settings use this copy; default backups and the CLI profile
remain alongside it. Explicit `-BackupRoot` still overrides backup placement. Reruns with the
installed file do not copy it onto itself. Invalid input never replaces an installed file.

Review correction: the configuration belongs to the same snapshot transaction as the client
settings and helpers. Publish it last, from the already validated values, not a later source
file read. Any publication/completion failure rolls all snapshotted files back; if rollback
itself fails, report the backup and both errors. A not-installed result does not publish.

Keeping downloads permanently was rejected: it preserves a fragile dependency and places
sign-in state in an unexpected folder.

## Consequences

One current configuration per OS user, as with the existing setup default. Reinstalling for
another gateway replaces this configuration only on successful setup. Restore returns the
previous configuration with the previous settings (or removes it if setup created it).
Switching gateways requires reconfiguring every client using this shared file; setup does
not rewrite the other client's helper.
Restore's existing changed-file protection prevents silently overwriting a later setup.
Snapshots do not migrate/delete CLI sign-in caches; sign in using the installed helper,
then remove any old download-folder profile through the approved device-cleanup process.

Source: [setup common functions](../../scripts/client/ClientGateway.Common.ps1).
