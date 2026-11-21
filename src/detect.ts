/** Classifies changed files and infers how to run a repository's tests. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FileKind = 'test' | 'impl' | 'other';

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)__snapshots__\//,
  /(^|\/)(test|tests|spec|specs|e2e|testing|fixtures?)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.[a-z]+\.(ts|js|tsx|jsx)$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_test\.go$/,
  /(^|\/)tests?\.(rs|java|kt|cs)$/,
  /(^|\/)Test[A-Z][^/]*\.(java|kt|cs)$/,
  /(^|\/)[A-Za-z0-9]*Tests?\.(java|kt|cs)$/,
  /(^|\/)[^/]*_spec\.rb$/,
  /(^|\/)[^/]*Test\.php$/,
];

const TEST_FILE_BASENAMES = new Set([
  'conftest.py',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  'playwright.config.ts',
]);

const IMPL_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.rb',
  '.php',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.swift',
  '.scala',
  '.ex',
  '.exs',
  '.lua',
  '.sh',
  '.sql',
]);

const NEVER_IMPL = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.github\//,
  /(^|\/)\.harness-bench\//,
  /(^|\/)docs?\//,
  /(^|\/)vendor\//,
  /(^|\/)third_party\//,
];

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'go.sum',
  'composer.lock',
]);

const SKIP_IMPL_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'setup.py',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'Dockerfile',
]);

export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

export function isTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return TEST_FILE_BASENAMES.has(basename(normalized)) && /\.(py|js|ts|mjs|cjs)$/.test(normalized);
}

export function isImplFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (isTestFile(normalized)) return false;
  if (NEVER_IMPL.some((pattern) => pattern.test(normalized))) return false;
  if (isLockfile(normalized)) return false;
  const base = basename(normalized);
  if (SKIP_IMPL_BASENAMES.has(base)) return false;
  if (base.startsWith('.')) return false;
  if (normalized.endsWith('.d.ts')) return false;
  if (normalized.endsWith('.md') || normalized.endsWith('.mdx')) return false;
  if (normalized.endsWith('.json') || normalized.endsWith('.yaml') || normalized.endsWith('.yml')) return false;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return IMPL_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

export function classifyFile(path: string): FileKind {
  if (isTestFile(path)) return 'test';
  if (isImplFile(path)) return 'impl';
  return 'other';
}

export interface FileBuckets {
  testFiles: string[];
  implFiles: string[];
  otherFiles: string[];
}

export function bucketFiles(paths: string[]): FileBuckets {
  const buckets: FileBuckets = { testFiles: [], implFiles: [], otherFiles: [] };
  for (const path of paths) {
    const kind = classifyFile(path);
    if (kind === 'test') buckets.testFiles.push(path);
    else if (kind === 'impl') buckets.implFiles.push(path);
    else buckets.otherFiles.push(path);
  }
  return buckets;
}

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

export function readPackageJson(repo: string): PackageJson | null {
  const file = join(repo, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

export function detectPackageManager(repo: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repo, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repo, 'bun.lockb')) || existsSync(join(repo, 'bun.lock'))) return 'bun';
  return 'npm';
}

/**
 * The command that runs the repository's own tests at the root.
 * Returns null when nothing recognizable is found (then `mine` needs --test-cmd).
 */
export function inferTestCommand(repo: string): string | null {
  const pkg = readPackageJson(repo);
  const pm = detectPackageManager(repo);
  if (pkg?.scripts?.test) {
    if (pm === 'npm') return 'npm test --silent';
    return `${pm} test`;
  }
  const hasDep = (name: string): boolean =>
    Boolean(pkg?.devDependencies?.[name] ?? pkg?.dependencies?.[name]);
  if (pkg && hasDep('vitest')) return 'npx vitest run';
  if (pkg && hasDep('jest')) return 'npx jest --ci';
  if (pkg && hasDep('mocha')) return 'npx mocha';

  const has = (name: string): boolean => existsSync(join(repo, name));
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('setup.cfg')) return 'python -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test --quiet';
  if (has('go.mod')) return 'go test ./...';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('build.gradle') || has('build.gradle.kts')) return './gradlew test';
  if (has('Makefile')) return 'make test';
  return null;
}

/** Prompt template: the commit message is the task, plus the rules of the bench. */
export function buildPrompt(commitMessage: string, testFiles: string[], testCommand: string): string {
  const subject = commitMessage.trim() || 'Make the failing tests pass.';
  const testList = testFiles.map((file) => `- ${file}`).join('\n');
  return [
    subject,
    '',
    '---',
    'Context: you are working in a clean checkout of the repository at the commit right before this change was made.',
    `The tests that describe this change are already present${testFiles.length > 0 ? `:\n${testList}` : '.'}`,
    `Verify with: ${testCommand}`,
    'Rules: make the tests pass. Do not modify or delete test files, test configuration or CI configuration.',
    'Keep the change scoped to the implementation.',
  ].join('\n');
}

/** Rejects test paths that are not really tests (snapshot fixtures etc. are fine to include). */
export function filterRunnableTestFiles(paths: string[]): string[] {
  return paths.filter((path) => !/(^|\/)__snapshots__\//.test(path));
}
