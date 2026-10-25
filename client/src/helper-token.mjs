// ADR-0041: in azure-cli sign-in mode the gateway token comes from the generated ccof-token.cmd helper, the
// same file Claude Code and Claude Desktop run. Its stdout is the token; its output is never echoed back, apart
// from a Microsoft Entra error code (AADSTSnnnnn) found in its error output.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ClientError } from './errors.mjs';

const TIMEOUT_MS = 60_000;
const AZURE_CLI_MISSING = 3;

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, windowsHide: true }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
  });
}

// `silent-token` never opens a sign-in: /usage and its status line run unattended (the `token` verb, used by
// Claude Code and Desktop, may). The helper runs in its own folder, so no az.cmd in the caller's folder is found.
export async function helperToken(helper, { timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof helper !== 'string' || !helper || !path.isAbsolute(helper) || /["%\r\n]/.test(helper)) {
    throw new ClientError('invalid_configuration', 'CCOF_TOKEN_HELPER must be the absolute path of ccof-token.cmd. Run the client installer again.');
  }
  const options = { cwd: path.dirname(helper), timeout: timeoutMs };
  let stdout;
  try {
    // Node starts .cmd files only through cmd.exe; the path is already free of quotes and % expansion.
    stdout = process.platform === 'win32'
      ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${helper}" silent-token"`], { ...options, windowsVerbatimArguments: true })
      : await run(helper, ['silent-token'], options);
  } catch (error) {
    if (error.killed) throw new ClientError('sign_in_timeout', `The Azure CLI helper gave no token within ${Math.round(timeoutMs / 1000)} seconds. Retry; if it persists, run "${helper}" status.`);
    if (error.code === AZURE_CLI_MISSING) throw new ClientError('azure_cli_missing', 'The Azure CLI is not installed where setup found it. Install it (https://aka.ms/installazurecliwindows), then run the client setup again.');
    const entra = /AADSTS\d{5,6}/.exec(String(error.stderr ?? ''));
    throw new ClientError('sign_in_required', `No gateway token${entra ? ` (Microsoft Entra ${entra[0]})` : ''}. Sign in: run "${helper}" login.${entra ? ' If sign-in fails again, give your admin this code.' : ''}`);
  }
  const token = String(stdout).trim();
  if (!token || /\s/.test(token)) {
    throw new ClientError('sign_in_required', `No gateway token. Sign in: run "${helper}" login.`);
  }
  return token;
}
