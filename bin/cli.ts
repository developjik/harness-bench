#!/usr/bin/env node
/**
 * Executable entry point. `realpathSync` resolves the symlink npm installs into
 * node_modules/.bin, so `npx @developjik/harness-bench` and a global install both work.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

function invokedSelf(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedSelf()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`fatal: ${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}

export { main };
