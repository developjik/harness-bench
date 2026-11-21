/**
 * Mock harness: never spends tokens. It writes a patch derived from the gold diff
 * so the whole pipeline (worktree → run → tests → score → report) is demonstrable.
 */

import { applyPatch } from '../git.js';
import { dropLastHunkPerFile, parsePatch, splitFileBlocks } from '../diff.js';
import type { MockMode } from '../types.js';
import type { DriverContext, DriverOutcome, HarnessDriver } from './types.js';

const DESCRIPTION: Record<MockMode, string> = {
  oracle: 'applies the full reference implementation patch',
  partial: 'applies the reference patch without its last implementation file (or last hunk)',
  noop: 'changes nothing',
};

export function partialPatch(implPatch: string): string {
  const blocks = splitFileBlocks(implPatch);
  if (blocks.length > 1) {
    return blocks
      .slice(0, -1)
      .map((block) => (block.endsWith('\n') ? block : `${block}\n`))
      .join('');
  }
  const reduced = dropLastHunkPerFile(implPatch);
  const stillHasHunks = parsePatch(reduced).some((file) => file.hunks.length > 0);
  return stillHasHunks ? reduced : '';
}

export function mockPatch(task: DriverContext['task'], mode: MockMode): string {
  if (mode === 'noop') return '';
  if (mode === 'partial') return partialPatch(task.implPatch);
  return task.implPatch;
}

export function createMockDriver(mode: MockMode = 'oracle'): HarnessDriver {
  return {
    id: 'mock',
    label: `mock (${mode})`,
    kind: 'mock',
    commandLine() {
      return `mock-driver --mode ${mode} (${DESCRIPTION[mode]})`;
    },
    async available() {
      return true;
    },
    async run(ctx: DriverContext): Promise<DriverOutcome> {
      const started = Date.now();
      const patch = mockPatch(ctx.task, mode);
      const lines = [
        `[mock:${mode}] ${DESCRIPTION[mode]}`,
        `[mock:${mode}] task ${ctx.task.id} (${ctx.task.implFiles.length} impl file(s), ${ctx.task.testFiles.length} test file(s))`,
        `[mock:${mode}] prompt head: ${ctx.prompt.split('\n')[0] ?? ''}`,
      ];
      let exitCode: number | null = 0;
      let stderr = '';

      if (patch.trim().length > 0) {
        const result = applyPatch(ctx.cwd, patch);
        if (!result.ok) {
          exitCode = 1;
          stderr = `mock patch failed to apply: ${result.stderr.trim()}\n`;
          lines.push(`[mock:${mode}] patch failed: ${result.stderr.trim()}`);
        } else {
          lines.push(`[mock:${mode}] patch applied (${patch.split('\n').length} lines)`);
        }
      } else {
        lines.push(`[mock:${mode}] no change made`);
      }

      const stdout = `${lines.join('\n')}\n`;
      ctx.onOutput?.('stdout', stdout);
      if (stderr) ctx.onOutput?.('stderr', stderr);
      return {
        exitCode,
        stdout,
        stderr,
        wallClockMs: Date.now() - started,
        timedOut: false,
        simulated: true,
        commandLine: this.commandLine(ctx),
        note: `mock(${mode}): ${DESCRIPTION[mode]}`,
      };
    },
  };
}
