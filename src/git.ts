/** Thin, synchronous wrappers around the git CLI. No network, no credentials. */

import { spawnSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  timeoutMs?: number;
  input?: string;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

const MAX_BUFFER = 128 * 1024 * 1024;

export function runGit(cwd: string, args: string[], options: GitOptions = {}): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: options.timeoutMs ?? 120_000,
    input: options.input,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      ...options.env,
    },
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function gitOrThrow(cwd: string, args: string[], options: GitOptions = {}): string {
  const result = runGit(cwd, args, options);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
  }
  return result.stdout;
}

export function isGitRepo(path: string): boolean {
  const result = runGit(path, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

export function repoRoot(path: string): string {
  const result = runGit(path, ['rev-parse', '--show-toplevel']);
  if (!result.ok) throw new Error(`not a git repository: ${path}`);
  return result.stdout.trim();
}

export function hasCommits(repo: string): boolean {
  return runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok;
}

export interface CommitFile {
  status: string;
  path: string;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  authorTime: number;
  message: string;
  files: CommitFile[];
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/**
 * Reads non-merge commits newest-first together with the files they touch.
 * `--name-status` lines follow the formatted header of each commit.
 */
export function listCommits(repo: string, limit: number, ref = 'HEAD'): CommitInfo[] {
  const format = ['%x1e%H', '%P', '%ct', '%B', ''].join('%x1f');
  const args = [
    'log',
    '--no-merges',
    `--max-count=${Math.max(1, limit)}`,
    `--format=${format}`,
    '--name-status',
    '-z',
    ref,
  ];
  // -z makes name-status entries NUL separated: "A\0path\0" — easier to parse than tabs.
  const raw = gitOrThrow(repo, args, { timeoutMs: 180_000 });
  return parseCommitLog(raw);
}

export function parseCommitLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of raw.split(RECORD)) {
    if (!record.trim()) continue;
    const parts = record.split(FIELD);
    if (parts.length < 5) continue;
    const sha = (parts[0] ?? '').trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const parents = (parts[1] ?? '').trim().split(/\s+/).filter(Boolean);
    const authorTime = Number.parseInt((parts[2] ?? '').trim(), 10) || 0;
    const message = parts.slice(3, parts.length - 1).join(FIELD).trim();
    const restRaw = parts[parts.length - 1] ?? '';
    commits.push({ sha, parents, authorTime, message, files: parseNameStatusZ(restRaw) });
  }
  return commits;
}

function parseNameStatusZ(rest: string): CommitFile[] {
  const tokens = rest.split('\0').map((token) => token.replace(/^\r?\n/, '')).filter((token) => token.length > 0);
  const files: CommitFile[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = (tokens[i] ?? '').trim();
    if (!/^[A-Z]\d*$/.test(status)) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 2;
      if (to) files.push({ status, path: to });
      else if (from) files.push({ status, path: from });
      continue;
    }
    const path = tokens[i + 1];
    i += 1;
    if (path) files.push({ status, path });
  }
  return files;
}

/** Unified diff between two commits, optionally restricted to paths. */
export function diffCommits(repo: string, base: string, target: string, paths?: string[]): string {
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--unified=3',
    base,
    target,
    '--',
    ...(paths && paths.length > 0 ? paths : ['.']),
  ];
  return gitOrThrow(repo, args, { timeoutMs: 180_000 });
}

export function currentHead(repo: string): string {
  return gitOrThrow(repo, ['rev-parse', 'HEAD']).trim();
}

export function commitExists(repo: string, sha: string): boolean {
  return runGit(repo, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

export interface WorktreeInfo {
  path: string;
  head: string;
}

export function addWorktree(repo: string, path: string, commit: string): void {
  gitOrThrow(repo, ['worktree', 'add', '--detach', '--force', path, commit]);
}

export function removeWorktree(repo: string, path: string): void {
  const result = runGit(repo, ['worktree', 'remove', '--force', path]);
  if (!result.ok) {
    // A worktree that was never registered (or already pruned) is not an error for the caller.
    runGit(repo, ['worktree', 'prune']);
  }
}

export function applyPatch(cwd: string, patch: string, opts: { threeWay?: boolean } = {}): GitResult {
  const args = ['apply', '--whitespace=nowarn'];
  if (opts.threeWay) args.push('--3way');
  return runGit(cwd, [...args, '-'], { input: patch });
}

/** Commit everything in the worktree so later diffs show only harness changes. */
export function commitAll(cwd: string, message: string): void {
  const add = runGit(cwd, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const commit = runGit(cwd, [
    '-c',
    'user.name=harness-bench',
    '-c',
    'user.email=bench@harness-bench.local',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '--allow-empty',
    '-m',
    message,
  ]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
}

/** Stage everything and return the patch of the working tree against HEAD. */
export function collectWorktreePatch(cwd: string): string {
  const add = runGit(cwd, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const diff = runGit(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--binary']);
  runGit(cwd, ['reset', '--quiet']);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  return diff.stdout;
}

export function listStatusFiles(cwd: string): string[] {
  const result = runGit(cwd, ['status', '--porcelain']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
