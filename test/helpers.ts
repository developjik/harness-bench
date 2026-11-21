/** Test helpers: throwaway git repositories with a known implementation+test history. */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  dir: string;
  write(path: string, content: string): void;
  delete(path: string): void;
  commit(message: string): string;
  head(): string;
  cleanup(): void;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function createTempDir(prefix = 'harness-bench-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createTempRepo(prefix = 'harness-bench-repo-'): TempRepo {
  const dir = createTempDir(prefix);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test Author']);
  git(dir, ['config', 'user.email', 'author@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);

  const repo: TempRepo = {
    dir,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    },
    delete(path) {
      rmSync(join(dir, path), { force: true });
    },
    commit(message) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '--no-verify', '-m', message]);
      return git(dir, ['rev-parse', 'HEAD']).trim();
    },
    head() {
      return git(dir, ['rev-parse', 'HEAD']).trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return repo;
}

export interface FixtureRepo {
  repo: TempRepo;
  baseSha: string;
  targetSha: string;
}

const PACKAGE_JSON = `${JSON.stringify(
  { name: 'fixture-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } },
  null,
  2,
)}\n`;

const MATH_BASE = `export const add = (a, b) => a + b;
`;
const MATH_TARGET = `export const add = (a, b) => a + b;
export const mul = (a, b) => a * b;
`;
const TEXT_BASE = `export const upper = (value) => value.toUpperCase();
`;
const TEXT_TARGET = `export const upper = (value) => value.toUpperCase();
export const slugify = (value) => value.toLowerCase().trim().replace(/\\s+/g, '-');
`;
const MATH_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, mul } from '../src/math.js';

test('adds numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('multiplies numbers', () => {
  assert.equal(mul(3, 4), 12);
});
`;
const TEXT_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { upper, slugify } from '../src/text.js';

test('uppercases text', () => {
  assert.equal(upper('ab'), 'AB');
});

test('slugifies text', () => {
  assert.equal(slugify('Hello  World'), 'hello-world');
});
`;

/** Three commits: setup, docs-only (must be skipped), and a two-file feature with tests. */
export function buildFixtureRepo(): FixtureRepo {
  const repo = createTempRepo();
  repo.write('README.md', '# fixture\n');
  repo.commit('docs: describe the fixture');

  repo.write('package.json', PACKAGE_JSON);
  repo.write('.gitignore', 'node_modules/\n');
  repo.write('src/math.js', MATH_BASE);
  repo.write('src/text.js', TEXT_BASE);
  const baseSha = repo.commit('chore: scaffold the fixture app');

  repo.write('src/math.js', MATH_TARGET);
  repo.write('src/text.js', TEXT_TARGET);
  repo.write('test/math.test.js', MATH_TEST);
  repo.write('test/text.test.js', TEXT_TEST);
  const targetSha = repo.commit('feat: multiply numbers and slugify text');
  return { repo, baseSha, targetSha };
}
