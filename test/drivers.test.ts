import { describe, expect, it } from 'vitest';
import { createCliDriver } from '../src/drivers/cli.js';
import { spawnProcess } from '../src/drivers/spawn.js';
import { runTests } from '../src/testrun.js';
import { createTempDir, createTempRepo } from './helpers.js';

const GHOST_BINARY = 'harness-bench-binary-that-does-not-exist';

function ghostDriver() {
  return createCliDriver({
    id: 'ghost',
    label: 'Ghost',
    binary: GHOST_BINARY,
    envVar: 'HARNESS_GHOST_CMD',
    example: 'ghost run "<prompt>"',
    args: (ctx) => ['run', ctx.prompt],
  });
}

describe('cli driver failure paths', () => {
  it('reports a missing binary without starting a process', async () => {
    const driver = ghostDriver();
    expect(await driver.available()).toBe(false);
    const outcome = await driver.run({
      cwd: createTempDir(),
      prompt: 'do the thing',
      task: {} as never,
      timeoutMs: 5_000,
      dryRun: false,
      mockMode: 'oracle',
      extraArgs: [],
      env: {},
    });
    expect(outcome.exitCode).toBe(127);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.note).toContain('binary not found');
    expect(outcome.stderr).toContain(GHOST_BINARY);
  });

  it('a dry run never touches the binary at all', async () => {
    const driver = ghostDriver();
    const outcome = await driver.run({
      cwd: createTempDir(),
      prompt: 'do the thing',
      task: {} as never,
      timeoutMs: 5_000,
      dryRun: true,
      mockMode: 'oracle',
      extraArgs: [],
      env: {},
    });
    expect(outcome.simulated).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });
});

describe('spawnProcess failure paths', () => {
  it('kills a process that runs past its timeout', async () => {
    const outcome = await spawnProcess('/bin/sh', ['-c', 'sleep 30'], {
      cwd: createTempDir(),
      timeoutMs: 500,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.code).toBeNull();
  }, 15_000);

  it('captures a non-zero exit and stderr', async () => {
    const outcome = await spawnProcess('/bin/sh', ['-c', 'echo oops >&2; exit 7'], {
      cwd: createTempDir(),
      timeoutMs: 5_000,
    });
    expect(outcome.code).toBe(7);
    expect(outcome.stderr).toContain('oops');
  });
});

describe('test command failure paths', () => {
  it('marks a failing test command as a failed run', async () => {
    const repo = createTempRepo();
    try {
      repo.write('package.json', '{"scripts":{"test":"exit 3"}}\n');
      repo.commit('chore: failing tests');
      const run = await runTests(repo.dir, 'npm test', 30_000);
      expect(run.summary.ran).toBe(true);
      expect(run.summary.exitCode).not.toBe(0);
      expect(run.summary.passRate).toBe(0);
      expect(run.summary.failed).toBeGreaterThanOrEqual(1);
    } finally {
      repo.cleanup();
    }
  });
});
