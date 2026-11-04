@echo off
rem Double-click setup: Claude Code for the CCOF gateway with the Azure CLI sign-in.
rem Keep this file, Install-ClaudeCodeAzureCli.ps1 and client-config.json in one folder.
setlocal
if not exist "%~dp0Install-ClaudeCodeAzureCli.ps1" (
  echo Install-ClaudeCodeAzureCli.ps1 is missing. Put it in the same folder as this file.
  pause
  exit /b 2
)
if not exist "%~dp0client-config.json" (
  echo client-config.json is missing. Put the file from your administrator in the same folder as this file.
  pause
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ClaudeCodeAzureCli.ps1" -ConfigPath "%~dp0client-config.json" -Confirmed -Login -Test
set "CCOF_EXIT=%errorlevel%"
echo.
pause
exit /b %CCOF_EXIT%
