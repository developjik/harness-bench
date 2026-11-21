import { describe, expect, it } from 'vitest';
import { mineTasks } from '../src/miner.js';
import { createMockDriver } from '../src/drivers/mock.js';
import { runTaskWithDriver } from '../src/runner.js';
import { renderHtml, renderTerminal, summarizeMeta } from '../src/report.js';
import { existsSync, readFileSync } from 'node:fs';
import type { MinedTask, RunResult } from '../src/types.js';
import { buildFixtureRepo, createTempDir } from './helpers.js';

async function runFixture(mode: 'oracle' | 'partial' | 'noop') {
  const fixture = buildFixtureRepo();
  const dataDir = createTempDir('harness-bench-data-');
  try {
    const task = mineTasks({ repo: fixture.repo.dir, maxTasks: 5 }).tasks[0] as MinedTask;
    const result = await runTaskWithDriver(task, createMockDriver(mode), {
      repo: fixture.repo.dir,
      dataDir,
      tasks: [task],
      drivers: [],
      timeoutMs: 60_000,
      testTimeoutMs: 120_000,
      dryRun: false,
      mockMode: mode,
      runBaseline: true,
      keepWorktree: false,
    });
    return { task, result, dataDir };
  } finally {
    fixture.repo.cleanup();
  }
}

describe('pipeline: mine → worktree run → score → report', () => {
  it(
    'the oracle mock makes the prepared tests pass and scores high',
    async () => {
      const { result } = await runFixture('oracle');
      expect(result.error).toBeUndefined();
      expect(result.baseline?.ran).toBe(true);
      expect(result.baseline?.failed).toBeGreaterThan(0);
      expect(result.test.ran).toBe(true);
      expect(result.test.failed).toBe(0);
      expect(result.test.passed).toBe(4);
      expect(result.score?.allTestsPassed).toBe(true);
      expect(result.score?.regressionFree).toBe(true);
      expect(result.score?.total).toBeGreaterThan(0.9);
      expect(result.filesTouched).toBe(2);
      expect(result.testFilesTouched).toEqual([]);
      expect(existsSync(result.logPath ?? '')).toBe(true);
    },
    180_000,
  );

  it(
    'the noop mock leaves the tests failing and scores low',
    async () => {
      const { result } = await runFixture('noop');
      expect(result.error).toBeUndefined();
      expect(result.test.failed).toBeGreaterThan(0);
      expect(result.score?.allTestsPassed).toBe(false);
      expect(result.score?.total).toBeLessThan(0.35);
      expect(result.filesTouched).toBe(0);
    },
    180_000,
  );

  it(
    'the partial mock lands between noop and oracle',
    async () => {
      const { result } = await runFixture('partial');
      expect(result.error).toBeUndefined();
      expect(result.filesTouched).toBe(1);
      expect(result.test.failed).toBeGreaterThan(0);
      expect(result.score?.total).toBeGreaterThan(0.2);
      expect(result.score?.total).toBeLessThan(0.95);
      expect(result.score?.regressionFree).toBe(true);
    },
    180_000,
  );

  it(
    'renders a terminal matrix and a self-contained HTML report',
    async () => {
      const oracle = await runFixture('oracle');
      const noop = await runFixture('noop');
      const results: RunResult[] = [oracle.result, noop.result];
      const meta = summarizeMeta(results, { dataDir: oracle.dataDir, tasks: 1, version: 'test' });
      const table = renderTerminal(results, meta, { color: false });
      expect(table).toContain('MATRIX');
      expect(table).toContain('DRIVER SUMMARY');
      expect(table).toContain(oracle.result.taskId);
      expect(table).toContain('mock:oracle');

      const html = renderHtml(results, meta);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('Score matrix');
      expect(html).toContain(oracle.result.taskId);
      expect(html).toContain('mock:noop');
      expect(html).not.toContain('<script');
    },
    240_000,
  );

  it(
    'writes the HTML report where asked',
    async () => {
      const { writeHtmlReport } = await import('../src/report.js');
      const { result } = await runFixture('oracle');
      const meta = summarizeMeta([result], { dataDir: createTempDir(), tasks: 1, version: 'test' });
      const path = writeHtmlReport(`${createTempDir('hb-report-')}/report.html`, renderHtml([result], meta));
      expect(readFileSync(path, 'utf8')).toContain('harness-bench');
    },
    180_000,
  );
});
