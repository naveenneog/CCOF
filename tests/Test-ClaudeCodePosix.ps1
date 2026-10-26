#Requires -Version 7.0
# ADR-0048: Claude Code setup on macOS and Linux. Runs on every platform (the POSIX branch is simulated on Windows).
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/client/tests/Test-ClaudeCodePosix.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
