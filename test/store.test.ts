import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectStoreKind,
  loadResults,
  openTaskStore,
  readJsonl,
  saveResults,
  taskStorePath,
} from '../src/store.js';
import { rescore, scoreRun } from '../src/scorer.js';
import type { MinedTask, RunResult, TestSummary } from '../src/types.js';
import { createTempDir } from './helpers.js';

function sampleTask(id: string): MinedTask {
  return {
    id,
    repo: '/tmp/repo',
    repoName: 'repo',
    baseCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40),
    authorTime: 1_700_000_000,
    commitMessage: 'feat: add mul',
    prompt: 'feat: add mul\n\nmake the tests pass',
    testCommand: 'npm test',
    testFiles: ['test/math.test.js'],
    implFiles: ['src/math.js'],
    otherFiles: [],
    goldStats: { files: 2, hunks: 2, added: 4, removed: 0 },
    goldPatch: 'diff --git a/src/math.js b/src/math.js\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1,2 @@\n+export const mul = () => 1;\n',
    testPatch: 'diff --git a/test/math.test.js b/test/math.test.js\n',
    implPatch: 'diff --git a/src/math.js b/src/math.js\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1,2 @@\n+export const mul = () => 1;\n',
    minedAt: '2026-11-21T00:00:00.000Z',
    mineVersion: '1',
  };
}

function summary(overrides: Partial<TestSummary> = {}): TestSummary {
  return {
    command: 'npm test',
    ran: true,
    exitCode: 0,
    passed: 4,
    failed: 0,
    skipped: 0,
    total: 4,
    passRate: 1,
    failedTests: [],
    countsKnown: true,
    durationMs: 100,
    ...overrides,
  };
}

describe('task store', () => {
  it('round-trips tasks through sqlite', () => {
    const dir = createTempDir('hb-store-');
    const store = openTaskStore('sqlite', dir);
    const saved = store.save([sampleTask('repo-1'), sampleTask('repo-2')]);
    expect(saved.inserted).toBe(2);
    expect(store.list()).toHaveLength(2);
    expect(store.get('repo-1')?.implFiles).toEqual(['src/math.js']);
    store.save([{ ...sampleTask('repo-1'), commitMessage: 'feat: updated' }]);
    expect(store.get('repo-1')?.commitMessage).toBe('feat: updated');
    expect(store.list()).toHaveLength(2);
    store.close();
    expect(existsSync(taskStorePath(dir, 'sqlite'))).toBe(true);

    const reopened = openTaskStore('sqlite', dir);
    expect(reopened.list()).toHaveLength(2);
    reopened.close();
  });

  it('round-trips tasks through jsonl', () => {
    const dir = createTempDir('hb-store-');
    const store = openTaskStore('jsonl', dir);
    store.save([sampleTask('repo-1')]);
    store.close();
    const path = taskStorePath(dir, 'jsonl');
    expect(existsSync(path)).toBe(true);
    expect(readJsonl<unknown>(path)).toHaveLength(1);
    const reopened = openTaskStore('jsonl', dir);
    expect(reopened.get('repo-1')?.testFiles).toEqual(['test/math.test.js']);
    reopened.close();
  });

  it('detects which store exists', () => {
    const dir = createTempDir('hb-store-');
    expect(detectStoreKind(dir)).toBe('sqlite');
    const store = openTaskStore('jsonl', dir);
    store.save([sampleTask('repo-9')]);
    store.close();
    expect(detectStoreKind(dir)).toBe('jsonl');
  });
});

describe('results store', () => {
  it('replaces a rerun by id and keeps other runs', () => {
    const dir = createTempDir('hb-results-');
    const base: RunResult = {
      id: 'repo-1__mock:oracle',
      taskId: 'repo-1',
      repoName: 'repo',
      driver: 'mock:oracle',
      dryRun: false,
      startedAt: '2026-11-21T00:00:00.000Z',
      finishedAt: '2026-11-21T00:00:01.000Z',
      wallClockMs: 10,
      exitCode: 0,
      timedOut: false,
      patch: '',
      patchFiles: [],
      filesTouched: 0,
      testFilesTouched: [],
      linesAdded: 0,
      linesRemoved: 0,
      test: summary(),
    };
    saveResults(dir, [base]);
    saveResults(dir, [{ ...base, wallClockMs: 99 }]);
    const loaded = loadResults(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.wallClockMs).toBe(99);
  });
});

describe('scoreRun', () => {
  const task = sampleTask('repo-1');

  it('scores a perfect run as 1', () => {
    const score = scoreRun(task, {
      patch: task.implPatch,
      patchFiles: ['src/math.js'],
      test: summary(),
      baseline: summary({ passed: 0, failed: 2, total: 2, passRate: 0, exitCode: 1, failedTests: ['multiplies'] }),
    });
    expect(score.total).toBe(1);
    expect(score.allTestsPassed).toBe(true);
    expect(score.regressionFree).toBe(true);
    expect(score.file.f1).toBe(1);
  });

  it('flags a new failure that was passing on the base', () => {
    const score = scoreRun(task, {
      patch: task.implPatch,
      patchFiles: ['src/math.js'],
      test: summary({ exitCode: 1, passed: 2, failed: 2, total: 4, passRate: 0.5, failedTests: ['adds', 'multiplies'] }),
      baseline: summary({ exitCode: 1, passed: 3, failed: 1, total: 4, passRate: 0.75, failedTests: ['multiplies'] }),
    });
    expect(score.regressionFree).toBe(false);
    expect(score.regressions).toContain('adds');
    expect(score.total).toBeLessThan(1);
  });

  it('does not invent regressions when fewer tests fail than on the base', () => {
    const score = scoreRun(task, {
      patch: task.implPatch,
      patchFiles: ['src/math.js'],
      test: summary({ exitCode: 1, passed: 3, failed: 1, total: 4, passRate: 0.75, failedTests: ['multiplies'] }),
      baseline: summary({ exitCode: 1, passed: 0, failed: 4, total: 4, passRate: 0, failedTests: ['adds', 'multiplies'] }),
    });
    expect(score.regressionFree).toBe(true);
  });

  it('penalises an empty patch', () => {
    const score = scoreRun(task, { patch: '', patchFiles: [], test: summary({ exitCode: 1, passed: 3, failed: 1, passRate: 0.75 }) });
    expect(score.diff).toBe(0);
    expect(score.total).toBeLessThan(0.8);
  });

  it('earns no test credit when the exit code marks the counts as uncertain', () => {
    const score = scoreRun(task, {
      patch: task.implPatch,
      patchFiles: ['src/math.js'],
      test: summary({ exitCode: 101, passed: 3, failed: 0, total: 3, passRate: 1, countsUncertain: true }),
      baseline: summary({ exitCode: 1, passed: 0, failed: 2, total: 2, passRate: 0 }),
    });
    expect(score.test).toBe(0);
    expect(score.solvedRate).toBe(0);
    expect(score.allTestsPassed).toBe(false);
  });

  it('does not credit tests that already passed on the prepared base', () => {
    const score = scoreRun(task, {
      patch: '',
      patchFiles: [],
      test: summary({ exitCode: 1, passed: 2, failed: 2, total: 4, passRate: 0.5, failedTests: ['multiplies', 'slugifies'] }),
      baseline: summary({ exitCode: 1, passed: 2, failed: 2, total: 4, passRate: 0.5, failedTests: ['multiplies', 'slugifies'] }),
    });
    expect(score.solvedRate).toBe(0);
    expect(score.total).toBeCloseTo(0.1, 5);
  });

  it('rescores stored results against mined tasks', () => {
    const run: RunResult = {
      id: 'repo-1__mock:oracle',
      taskId: 'repo-1',
      repoName: 'repo',
      driver: 'mock:oracle',
      dryRun: false,
      startedAt: '',
      finishedAt: '',
      wallClockMs: 1,
      exitCode: 0,
      timedOut: false,
      patch: task.implPatch,
      patchFiles: ['src/math.js'],
      filesTouched: 1,
      testFilesTouched: [],
      linesAdded: 1,
      linesRemoved: 0,
      test: summary(),
    };
    const [rescored] = rescore([run], [task]);
    expect(rescored?.score?.total).toBe(1);
  });
});

describe('paths', () => {
  it('keeps store files inside the data directory', () => {
    const dir = createTempDir('hb-store-');
    expect(taskStorePath(dir, 'sqlite')).toBe(join(dir, 'tasks.db'));
    expect(taskStorePath(dir, 'jsonl')).toBe(join(dir, 'tasks.jsonl'));
  });
});
