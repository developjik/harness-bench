/**
 * Runs every (task × driver) pair in an isolated git worktree:
 * prepare base + tests → optional baseline test run → harness → patch → tests → score.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addWorktree,
  applyPatch,
  collectWorktreePatch,
  commitAll,
  removeWorktree,
  repoRoot,
} from './git.js';
import { patchStats } from './diff.js';
import { linkWorktreeDependencies } from './deps.js';
import { scoreRun } from './scorer.js';
import { emptyTestSummary, runTests } from './testrun.js';
import type { MinedTask, MockMode, RunResult, TestSummary } from './types.js';
import type { HarnessDriver } from './drivers/types.js';
import { nowIso, repoLabel, shortSha } from './util.js';

export interface RunOptions {
  repo: string;
  dataDir: string;
  tasks: MinedTask[];
  drivers: HarnessDriver[];
  timeoutMs: number;
  testTimeoutMs: number;
  dryRun: boolean;
  mockMode: MockMode;
  runBaseline: boolean;
  keepWorktree: boolean;
  /** Symlink installed dependencies (node_modules, .venv) into the worktree. Default true. */
  linkDeps?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
}

export function runLabel(driver: HarnessDriver, mockMode: MockMode): string {
  return driver.id === 'mock' ? `mock:${mockMode}` : driver.id;
}

function logTo(path: string, text: string): void {
  try {
    appendFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  } catch {
    /* logging must never break the run */
  }
}

export async function runTaskWithDriver(task: MinedTask, driver: HarnessDriver, options: RunOptions): Promise<RunResult> {
  const repo = repoRoot(options.repo);
  const driverLabel = runLabel(driver, options.mockMode);
  const startedAt = nowIso();
  const runId = `${task.id}__${driverLabel}`;
  const worktreesDir = join(options.dataDir, 'worktrees');
  const logsDir = join(options.dataDir, 'logs');
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const slug = `${task.id}-${driverLabel}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const worktreePath = join(worktreesDir, slug);
  const logPath = join(logsDir, `${slug}.log`);

  const baseResult: RunResult = {
    id: runId,
    taskId: task.id,
    repoName: task.repoName || repoLabel(repo),
    driver: driverLabel,
    mockMode: driver.id === 'mock' ? options.mockMode : undefined,
    dryRun: options.dryRun,
    startedAt,
    finishedAt: startedAt,
    wallClockMs: 0,
    exitCode: null,
    timedOut: false,
    patch: '',
    patchFiles: [],
    filesTouched: 0,
    testFilesTouched: [],
    linesAdded: 0,
    linesRemoved: 0,
    test: emptyTestSummary(task.testCommand, 'not run'),
    logPath,
    worktreePath: options.keepWorktree ? worktreePath : undefined,
  };

  let created = false;
  let driverWallClock = 0;
  let outcomeExit: number | null = null;
  let outcomeTimedOut = false;
  let driverNote: string | undefined;
  let commandLine: string | undefined;
  let baseline: TestSummary | undefined;
  let finalTest: TestSummary = baseResult.test;
  let patch = '';
  let error: string | undefined;

  const env = { ...(options.env ?? {}) };

  try {
    addWorktree(repo, worktreePath, task.baseCommit);
    created = true;
    logTo(logPath, `# ${runId}\nrepo: ${repo}\ntask: ${task.id}\nbase: ${task.baseCommit}\ntarget: ${task.targetCommit}\nworktree: ${worktreePath}\n`);

    if (task.testPatch.trim().length > 0) {
      let applied = applyPatch(worktreePath, task.testPatch);
      if (!applied.ok) applied = applyPatch(worktreePath, task.testPatch, { threeWay: true });
      if (!applied.ok) {
        throw new Error(`test patch did not apply to the base commit: ${applied.stderr.trim().split('\n')[0] ?? 'unknown error'}`);
      }
    }
    commitAll(worktreePath, `harness-bench: prepare ${task.id} (base ${shortSha(task.baseCommit)} + tests)`);

    const linked = options.linkDeps === false ? [] : linkWorktreeDependencies(repo, worktreePath);
    if (linked.length > 0) {
      logTo(logPath, `\n## linked dependencies\n${linked.map((entry) => `${entry.path} -> ${entry.target}`).join('\n')}\n`);
    }

    if (options.runBaseline) {
      options.onProgress?.(`  · baseline tests ${task.id} [${driverLabel}]`);
      const run = await runTests(worktreePath, task.testCommand, options.testTimeoutMs, env);
      baseline = run.summary;
      logTo(logPath, `\n## baseline tests (${run.summary.durationMs}ms, exit ${run.summary.exitCode})\n${run.output}\n`);
      options.onProgress?.(
        `    baseline: ${baseline.countsKnown ? `${baseline.passed}/${baseline.total}` : `exit ${baseline.exitCode}`} (${baseline.failed} failing)`,
      );
    }

    options.onProgress?.(`  ▶ ${task.id} × ${driverLabel}`);
    const outcome = await driver.run({
      cwd: worktreePath,
      prompt: task.prompt,
      task,
      timeoutMs: options.timeoutMs,
      dryRun: options.dryRun,
      mockMode: options.mockMode,
      extraArgs: options.extraArgs ?? [],
      env,
      onOutput: (stream, chunk) => logTo(logPath, `[${stream}] ${chunk}`),
    });
    driverWallClock = outcome.wallClockMs;
    outcomeExit = outcome.exitCode;
    outcomeTimedOut = outcome.timedOut;
    driverNote = outcome.note;
    commandLine = outcome.commandLine;
    logTo(logPath, `\n## driver ${driverLabel} exit=${outcome.exitCode} timedOut=${outcome.timedOut}\n${outcome.stdout}\n${outcome.stderr}\n`);

    patch = collectWorktreePatch(worktreePath);
    logTo(logPath, `\n## patch\n${patch}\n`);

    options.onProgress?.(`    tests ${task.id} [${driverLabel}]`);
    const run = await runTests(worktreePath, task.testCommand, options.testTimeoutMs, env);
    finalTest = run.summary;
    logTo(logPath, `\n## tests after run (${run.summary.durationMs}ms, exit ${run.summary.exitCode})\n${run.output}\n`);
  } catch (caught) {
    error = (caught as Error).message;
    logTo(logPath, `\n## error\n${error}\n`);
  } finally {
    if (created && !options.keepWorktree) {
      try {
        removeWorktree(repo, worktreePath);
      } catch {
        /* leave it for `git worktree prune` */
      }
    }
  }

  const stats = patchStats(patch);
  const patchFiles = stats.paths;
  const testFilesTouched = patchFiles.filter((file) => task.testFiles.includes(file));
  const result: RunResult = {
    ...baseResult,
    finishedAt: nowIso(),
    wallClockMs: driverWallClock,
    exitCode: outcomeExit,
    timedOut: outcomeTimedOut,
    error,
    patch,
    patchFiles,
    filesTouched: patchFiles.length,
    testFilesTouched,
    linesAdded: stats.added,
    linesRemoved: stats.removed,
    test: finalTest,
    baseline,
    driverNote,
    commandLine,
  };

  result.score = scoreRun(task, {
    patch: result.patch,
    patchFiles: result.patchFiles,
    test: result.test,
    baseline: result.baseline,
  });
  return result;
}

export async function runMatrix(options: RunOptions): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const task of options.tasks) {
    for (const driver of options.drivers) {
      const result = await runTaskWithDriver(task, driver, options);
      results.push(result);
      const score = result.score?.total;
      options.onProgress?.(
        `  ${result.error ? '✖' : result.score?.allTestsPassed ? '✓' : '✗'} ${task.id} × ${result.driver} → ${
          score === undefined ? '—' : score.toFixed(2)
        }${result.error ? ` (${result.error.split('\n')[0]})` : ''}`,
      );
    }
  }
  return results;
}
