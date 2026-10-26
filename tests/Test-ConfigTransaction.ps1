#Requires -Version 7.0
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\client\tests\Test-ConfigTransaction.ps1')
exit $LASTEXITCODE
