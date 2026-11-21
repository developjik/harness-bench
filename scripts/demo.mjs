#!/usr/bin/env node
/**
 * Zero-cost demo: builds a throwaway git repository with two real
 * implementation+test commits, mines them, runs the mock harnesses and
 * writes an HTML report. Nothing outside os.tmpdir() and reports/ is touched,
 * and no tokens are spent.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'bin', 'cli.js');

try {
  accessSync(cli);
} catch {
  console.error('dist/bin/cli.js is missing — run `npm run build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'harness-bench-demo-'));
const dataDir = join(dir, '.harness-bench');

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    console.error(`$ ${command} ${args.join(' ')}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function write(path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commit(message) {
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', message]);
}

function run(label, args) {
  console.log(`\n$ harness-bench ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

sh('git', ['init', '-q', '-b', 'main']);
sh('git', ['config', 'user.name', 'Demo Author']);
sh('git', ['config', 'user.email', 'demo@example.com']);
sh('git', ['config', 'commit.gpgsign', 'false']);

write(
  'package.json',
  JSON.stringify({ name: 'demo-shop', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
);
write('.gitignore', 'node_modules/\n.harness-bench/\n');
write('README.md', '# demo-shop\n');
commit('docs: start the demo shop');

write(
  'src/math.js',
  `export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
`,
);
write(
  'src/money.js',
  `export const formatWon = (amount) => amount.toFixed(0) + '원';
`,
);
commit('chore: add math and money helpers');

write(
  'src/math.js',
  `export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
export const mul = (a, b) => a * b;
`,
);
write(
  'test/math.test.js',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/math.js';

test('multiplies', () => {
  assert.equal(mul(6, 7), 42);
});
`,
);
commit('feat: add multiplication');

write(
  'src/money.js',
  `export const formatWon = (amount) => amount.toFixed(0) + '원';
export const roundWon = (amount) => Math.round(amount);
`,
);
write(
  'test/money.test.js',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { roundWon } from '../src/money.js';

test('rounds to the nearest won', () => {
  assert.equal(roundWon(1000.4), 1000);
  assert.equal(roundWon(1000.6), 1001);
});
`,
);
commit('fix: round won amounts');

console.log(`demo repository: ${dir}`);

run('[mine]', ['mine', '--repo', dir, '--data-dir', dataDir, '--limit', '20', '--max-tasks', '10']);
run('[run/oracle]', ['run', '--repo', dir, '--data-dir', dataDir, '--driver', 'mock', '--mock-mode', 'oracle']);
run('[run/noop]', ['run', '--repo', dir, '--data-dir', dataDir, '--driver', 'mock', '--mock-mode', 'noop']);
run('[report]', ['report', '--data-dir', dataDir]);

const htmlPath = join(root, 'reports', 'demo.html');
run('[report/html]', ['report', '--data-dir', dataDir, '--format', 'html', '--out', htmlPath]);

console.log(`\nHTML report: ${htmlPath}`);
if (!process.env.HARNESS_BENCH_KEEP_DEMO) rmSync(dir, { recursive: true, force: true });
