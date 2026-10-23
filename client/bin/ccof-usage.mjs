#!/usr/bin/env node
import { runUsageCli } from '../src/usage.mjs';

const exitCode = await runUsageCli(process.argv.slice(2));
await Promise.all([new Promise((resolve) => process.stdout.write('', resolve)),
  new Promise((resolve) => process.stderr.write('', resolve))]);
process.exit(exitCode);
