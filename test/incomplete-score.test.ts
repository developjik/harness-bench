import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreRun } from '../src/scorer.js';
import { runShellCommand, summarizeTestRun } from '../src/testrun.js';
import type { MinedTask, TestSummary } from '../src/types.js';

const task = { id: 'timeout', implFiles: [], implPatch: '' } as unknown as MinedTask;
const parse = (passed: number, failed: number, code: number | null, timedOut = false) => summarizeTestRun('test', {
  stdout: `Tests ${failed} failed | ${passed} passed (${passed + failed})`, stderr: '', code, timedOut, durationMs: 1,
});
const grade = (test: TestSummary, baseline?: TestSummary) => scoreRun(task, { patch: '', patchFiles: [], test, baseline });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('incomplete test scoring (DEV-153)', () => {
  it('keeps counts from a real process timeout as diagnostics without solved credit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-timeout-')); dirs.push(dir);
    writeFileSync(join(dir, 'test.cjs'), "console.log('Tests 1 passed (1)'); setInterval(() => {}, 1000);\n");
    // The executable is trusted test infrastructure, not a user-provided shell argument.
    const command = `'${process.execPath.replace(/'/g, "'\\''")}' test.cjs`;
    const result = await runShellCommand(dir, command, 1000);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    const final = summarizeTestRun('test', result);
    expect(final).toMatchObject({ countsKnown: true, passed: 1, failed: 0, passRate: 1, timedOut: true });
    expect(grade(final, parse(0, 1, 1))).toMatchObject({ test: 0, solvedRate: 0, total: 0, allTestsPassed: false, regressionStatus: 'unknown' });
    expect(grade(parse(1, 0, 0), parse(0, 1, 1))).toMatchObject({ test: 1, solvedRate: 1, total: 0.7, allTestsPassed: true });
  }, 10_000);

  it.each([
    { timedOut: true }, { exitCode: null }, { ran: false }, { countsUncertain: true },
    { timedOut: true, exitCode: 0 },
  ])('rejects incomplete final summaries even when they retain full passRate: %j', override => {
    const final = { ...parse(3, 0, 0), ...override };
    expect(grade(final, parse(0, 3, 1))).toMatchObject({ test: 0, solvedRate: 0, allTestsPassed: false, regressionStatus: 'unknown' });
    expect(grade(final)).toMatchObject({ test: 0, solvedRate: 0 });
  });

  it.each([{ timedOut: true }, { exitCode: null }, { ran: false }, { countsUncertain: true }])('does not trust an incomplete baseline denominator: %j', override => {
    const baseline = { ...parse(0, 3, 1), ...override };
    expect(grade(parse(3, 0, 0), baseline)).toMatchObject({ test: 1, solvedRate: 0, allTestsPassed: true });
    expect(grade(parse(2, 1, 1), baseline)).toMatchObject({ test: 0.6667, solvedRate: 0, regressionStatus: 'unknown' });
  });

  it('keeps normal completed fail, pass, and absent-baseline rules', () => {
    const baseline = parse(1, 2, 1);
    expect(grade(parse(2, 1, 1), baseline)).toMatchObject({ test: 0.6667, solvedRate: 0.5, allTestsPassed: false });
    expect(grade(parse(3, 0, 0), baseline)).toMatchObject({ test: 1, solvedRate: 1, allTestsPassed: true });
    expect(grade(parse(2, 1, 1))).toMatchObject({ test: 0.6667, solvedRate: 0.6667 });
  });
});
