import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { helperToken } from '../src/helper-token.mjs';

const windows = process.platform === 'win32';

async function withHelper(body, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccof helper '));
  const file = path.join(dir, windows ? 'ccof-token.cmd' : 'ccof-token.sh');
  await writeFile(file, windows ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  // A timed-out helper's child (ping) can hold the folder for a few seconds after cmd.exe is stopped.
  try { return await run(file); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
}

test('the helper token is its trimmed stdout; the helper gets the non-interactive silent-token argument (ADR-0041)', { skip: !windows && 'cmd helper' }, async () => {
  await withHelper('if "%~1"=="silent-token" (echo eyJ.helper.token) else (exit /b 7)', async (file) => {
    assert.equal(await helperToken(file), 'eyJ.helper.token');
  });
});

test('a failing or silent helper gives a sign-in instruction, never its output', { skip: !windows && 'cmd helper' }, async () => {
  await withHelper('echo partial-secret-output\r\nexit /b 4', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'sign_in_required' && error.message.includes(`"${file}" login`) && !error.message.includes('partial-secret'));
  });
  await withHelper('exit /b 0', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'sign_in_required');
  });
});

test('an unset, relative or cmd-unsafe helper path is refused before anything runs', async () => {
  for (const value of [undefined, '', 'ccof-token.cmd', 'C:\\a"b\\ccof-token.cmd', 'C:\\a%PATH%\\ccof-token.cmd', 'C:\\a\nb\\ccof-token.cmd']) {
    await assert.rejects(helperToken(value), (error) => error.code === 'invalid_configuration', String(value));
  }
});

test('the helper runs in its own folder, so a planted az.cmd in the caller\'s folder is never found first', { skip: !windows && 'cmd helper' }, async () => {
  await withHelper('if /i "%cd%\\"=="%~dp0" (echo eyJ.own.folder) else (echo eyJ.wrong.folder)', async (file) => {
    assert.equal(await helperToken(file), 'eyJ.own.folder');
  });
});

test('helper failures are told apart: Azure CLI missing, a Microsoft Entra refusal code, and a timeout', { skip: !windows && 'cmd helper' }, async () => {
  await withHelper('>&2 echo The Azure CLI is not installed\r\nexit /b 3', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'azure_cli_missing' && /aka\.ms\/installazurecliwindows/.test(error.message));
  });
  await withHelper('>&2 echo ERROR: AADSTS53003: Access has been blocked by Conditional Access policies. eyJ.secret\r\nexit /b 4', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'sign_in_required' && error.message.includes('AADSTS53003') && !error.message.includes('eyJ.secret'));
  });
  await withHelper('ping -n 5 127.0.0.1 >nul\r\necho eyJ.late', async (file) => {
    await assert.rejects(helperToken(file, { timeoutMs: 500 }), (error) => error.code === 'sign_in_timeout');
  });
});

// ADR-0048: on macOS and Linux the helper is the generated sh script, run directly in its own folder.
test('off Windows the sh helper gives the token, and its failures are told apart', { skip: windows && 'sh helper' }, async () => {
  await withHelper('[ "$1" = silent-token ] && [ "$(pwd -P)/" = "$(cd "$(dirname "$0")" && pwd -P)/" ] && echo eyJ.helper.token && exit 0\nexit 7', async (file) => {
    assert.equal(await helperToken(file), 'eyJ.helper.token');
  });
  await withHelper('echo partial-secret-output\necho "ERROR: AADSTS53003: blocked" >&2\nexit 4', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'sign_in_required' && error.message.includes('AADSTS53003') && error.message.includes(`"${file}" login`) && !error.message.includes('partial-secret'));
  });
  await withHelper('echo "The Azure CLI is not installed" >&2\nexit 3', async (file) => {
    await assert.rejects(helperToken(file), (error) => error.code === 'azure_cli_missing' && /brew install azure-cli/.test(error.message) && !/installazurecliwindows/.test(error.message));
  });
});