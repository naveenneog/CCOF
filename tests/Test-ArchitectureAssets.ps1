#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
# macOS and most Linux distributions install Python 3 only as python3.
$python = @('python', 'python3' | ForEach-Object { Get-Command $_ -CommandType Application -ErrorAction SilentlyContinue } | Select-Object -First 1)[0]
if (-not $python) { throw 'Python 3 is required for the architecture asset test.' }
& $python.Source (Join-Path $PSScriptRoot 'test_architecture_assets.py')
if ($LASTEXITCODE -ne 0) { throw 'Architecture assets failed validation.' }
