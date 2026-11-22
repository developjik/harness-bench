/**
 * Opt-in integration test: spawns a real harness CLI through the real driver
 * path. Runs only when HARNESS_BENCH_INTEGRATION=1 — CI never sets it, so the
 * suite stays hermetic there.
 *
 * Pick the harness with HARNESS_BENCH_INTEGRATION_DRIVER (default `damon`) and,
 * for damon, the backend with HARNESS_DAMON_BACKEND (the driver default is
 * `claude`; damond must be running and the backend logged in).
 */
import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/drivers/index.js';
import { mineTasks } from '../src/miner.js';
import { runTaskWithDriver } from '../src/runner.js';
import type { MinedTask } from '../src/types.js';
import { buildFixtureRepo, createTempDir } from './helpers.js';

const ENABLED = process.env.HARNESS_BENCH_INTEGRATION === '1';
const DRIVER_ID = process.env.HARNESS_BENCH_INTEGRATION_DRIVER ?? 'damon';

const runIf = ENABLED ? it : it.skip;

describe(`integration: real ${DRIVER_ID} harness in a worktree`, () => {
  runIf(
    'runs the driver end to end and collects the patch it leaves',
    async () => {
      const fixture = buildFixtureRepo();
      const dataDir = createTempDir('harness-bench-integration-');
      try {
        const task = mineTasks({ repo: fixture.repo.dir, maxTasks: 5 }).tasks[0] as MinedTask;
        const driver = createDriver(DRIVER_ID);
        expect(await driver.available()).toBe(true);

        const result = await runTaskWithDriver(task, driver, {
          repo: fixture.repo.dir,
          dataDir,
          tasks: [task],
          drivers: [driver],
          timeoutMs: 300_000,
          testTimeoutMs: 120_000,
          dryRun: false,
          mockMode: 'oracle',
          runBaseline: true,
          keepWorktree: false,
          env: process.env.HARNESS_DAMON_BACKEND
            ? { HARNESS_DAMON_BACKEND: process.env.HARNESS_DAMON_BACKEND }
            : {},
        });

        expect(result.error).toBeUndefined();
        expect(result.timedOut).toBe(false);
        expect(result.commandLine).toBeTruthy();
        expect(result.baseline?.ran).toBe(true);
        expect(result.test.ran).toBe(true);
        // The pipeline must collect the work the harness left in the worktree —
        // including work the harness committed itself.
        expect(result.patch.trim().length).toBeGreaterThan(0);
        expect(result.filesTouched).toBeGreaterThan(0);
      } finally {
        fixture.repo.cleanup();
      }
    },
    360_000,
  );
});
