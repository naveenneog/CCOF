import { ClientError } from './errors.mjs';
import { loadConfig } from './config.mjs';
import { createTokenService } from './token-service.mjs';

const usage = 'Usage: ccof-token login [--device-code] | token | status | logout';

async function defaultService(stderr) {
  const { config, configPath } = await loadConfig();
  if (config.signInMethod === 'azure-cli') {
    // ADR-0041: Claude Code and Desktop run the Azure CLI helper; an MSAL sign-in here would never be used.
    throw new ClientError('azure_cli_sign_in', process.platform === 'win32'
      ? 'This configuration signs in through the Azure CLI. Run "%USERPROFILE%\\.claude\\ccof-token.cmd" login '
        + '(Claude Code), or "%LOCALAPPDATA%\\Claude-3p\\ccof-token.cmd" login when only Claude Desktop is set up.'
      // ADR-0048: macOS and Linux have the Claude Code sh helper only.
      : 'This configuration signs in through the Azure CLI. Run ~/.claude/ccof-token login (Claude Code).');
  }
  const { createRuntime } = await import('./msal-runtime.mjs');
  const runtime = await createRuntime(config, configPath, { report: (code) => stderr(`${code}\n`) });
  return createTokenService(config, runtime);
}

export async function runCli(args, {
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
  loadService = () => defaultService(stderr),
} = {}) {
  const [command, flag] = args;
  if (args.length === 1 && ['--help', '-h'].includes(command)) { stdout(`${usage}\n`); return 0; }
  if (!['login', 'token', 'status', 'logout'].includes(command) || args.length > 2 ||
      (flag !== undefined && !(command === 'login' && flag === '--device-code'))) {
    stderr(`${usage}\n`);
    return 2;
  }
  try {
    const service = await loadService();
    if (command === 'token') stdout(`${await service.token()}\n`);
    else if (command === 'login') {
      const status = await service.login({ deviceCode: flag === '--device-code', onDeviceCode: (response) => {
        // Device codes are shown only in the explicitly requested interactive command, never logs.
        stderr(`Open ${response.verificationUri} and enter code ${response.userCode}.\n`);
      } });
      stdout(`${JSON.stringify(status)}\n`);
    } else stdout(`${JSON.stringify(await service[command]())}\n`);
    return 0;
  } catch (error) {
    stderr(error instanceof ClientError ? `${error.code}: ${error.message}\n`
      : 'authentication_unavailable: Cannot access the secure sign-in cache or Entra. Run ccof-token login and retry.\n');
    return 1;
  }
}
