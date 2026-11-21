/**
 * Task miner: finds commits in a local repository that changed implementation
 * files and test files together, and turns each into a benchmark case.
 *
 * The base commit is the commit's parent, so the checkout used for a run is
 * exactly the state before the change. Only the test hunks are applied on top —
 * the harness has to produce the implementation itself.
 */

import { commitExists, diffCommits, listCommits, repoRoot, runGit } from './git.js';
import { buildPrompt, bucketFiles, filterRunnableTestFiles, inferTestCommand } from './detect.js';
import { filterPatch, patchStats } from './diff.js';
import type { MinedTask } from './types.js';
import { MINE_VERSION, nowIso, repoLabel, shortSha } from './util.js';

export interface MineOptions {
  repo: string;
  limit?: number;
  maxTasks?: number;
  since?: string;
  testCommand?: string;
  maxDiffLines?: number;
  promptTemplate?: string;
  includeIds?: string[];
}

export interface SkipRecord {
  sha: string;
  reason: string;
}

export interface MineReport {
  repo: string;
  repoName: string;
  head: string;
  testCommand: string;
  scanned: number;
  tasks: MinedTask[];
  skipped: SkipRecord[];
}

const SKIP_MESSAGE = /^(revert\b|fixup!|squash!|wip\b|tmp\b|temp\b|merge (branch|pull|remote))/i;

export function mineTasks(options: MineOptions): MineReport {
  const repo = repoRoot(options.repo);
  const repoName = repoLabel(repo);
  const limit = options.limit ?? 200;
  const maxTasks = options.maxTasks ?? 25;
  const maxDiffLines = options.maxDiffLines ?? 1_200;

  const testCommand = options.testCommand ?? inferTestCommand(repo);
  if (!testCommand) {
    throw new Error(
      'Could not infer a test command for this repository. Pass --test-cmd "<command>" (for example --test-cmd "npm test --silent").',
    );
  }

  const sinceSeconds = options.since ? Math.floor(Date.parse(options.since) / 1000) : null;
  if (options.since && (!sinceSeconds || Number.isNaN(sinceSeconds))) {
    throw new Error(`Invalid --since value: ${options.since} (use an ISO date such as 2026-01-01)`);
  }

  const head = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const commits = listCommits(repo, limit);
  if (commits.length === 0) {
    return { repo, repoName, head, testCommand, scanned: 0, tasks: [], skipped: [] };
  }

  const tasks: MinedTask[] = [];
  const skipped: SkipRecord[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const commit of commits) {
    if (tasks.length >= maxTasks) break;
    if (sinceSeconds !== null && commit.authorTime < sinceSeconds) continue;
    scanned += 1;

    const sha = shortSha(commit.sha);
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);

    if (commit.parents.length === 0) {
      skipped.push({ sha, reason: 'root commit (no parent to use as a clean base)' });
      continue;
    }
    if (commit.parents.length > 1) {
      skipped.push({ sha, reason: 'merge commit' });
      continue;
    }
    if (SKIP_MESSAGE.test(commit.message.trim())) {
      skipped.push({ sha, reason: 'message looks like noise (wip/merge/revert/fixup)' });
      continue;
    }

    const baseCommit = commit.parents[0] as string;
    if (!commitExists(repo, baseCommit)) {
      skipped.push({ sha, reason: 'parent commit is missing (shallow clone?)' });
      continue;
    }

    const buckets = bucketFiles(commit.files.map((file) => file.path));
    if (buckets.testFiles.length === 0) {
      skipped.push({ sha, reason: 'no test files changed' });
      continue;
    }
    if (buckets.implFiles.length === 0) {
      skipped.push({ sha, reason: 'no implementation files changed' });
      continue;
    }
    const deletedTests = commit.files.filter((file) => file.status.startsWith('D') && buckets.testFiles.includes(file.path));
    if (deletedTests.length > 0) {
      skipped.push({ sha, reason: `deletes test files (${deletedTests.map((file) => file.path).join(', ')})` });
      continue;
    }

    const goldPatch = diffCommits(repo, baseCommit, commit.sha, [
      ...buckets.testFiles,
      ...buckets.implFiles,
    ]);
    if (!goldPatch.trim()) {
      skipped.push({ sha, reason: 'diff is empty for the changed source/test files' });
      continue;
    }

    const stats = patchStats(goldPatch);
    if (stats.added + stats.removed > maxDiffLines) {
      skipped.push({ sha, reason: `diff too large (${stats.added + stats.removed} changed lines > ${maxDiffLines})` });
      continue;
    }
    if (stats.binaryFiles > 0) {
      skipped.push({ sha, reason: 'binary files in the change' });
      continue;
    }

    const runnableTests = filterRunnableTestFiles(buckets.testFiles);
    const testPatch = filterPatch(goldPatch, runnableTests);
    const implPatch = filterPatch(goldPatch, buckets.implFiles);
    if (!testPatch.trim()) {
      skipped.push({ sha, reason: 'no text hunks in the test files' });
      continue;
    }
    if (!implPatch.trim()) {
      skipped.push({ sha, reason: 'no text hunks in the implementation files' });
      continue;
    }

    const prompt = options.promptTemplate
      ? options.promptTemplate
          .replace(/\{message\}/g, commit.message)
          .replace(/\{tests\}/g, runnableTests.join('\n'))
          .replace(/\{testCommand\}/g, testCommand)
      : buildPrompt(commit.message, runnableTests, testCommand);

    tasks.push({
      id: `${repoName}-${sha}`,
      repo,
      repoName,
      baseCommit,
      targetCommit: commit.sha,
      authorTime: commit.authorTime,
      commitMessage: commit.message,
      prompt,
      testCommand,
      testFiles: runnableTests,
      implFiles: buckets.implFiles,
      otherFiles: buckets.otherFiles,
      goldStats: {
        files: stats.files,
        hunks: stats.hunks,
        added: stats.added,
        removed: stats.removed,
      },
      goldPatch,
      testPatch,
      implPatch,
      minedAt: nowIso(),
      mineVersion: MINE_VERSION,
    });
  }

  return { repo, repoName, head, testCommand, scanned, tasks, skipped };
}
