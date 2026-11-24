import {describe,expect,it} from 'vitest';
import {assessRegressions,detectRegressions,scoreRun} from '../src/scorer.js';
import type {TestSummary,MinedTask} from '../src/types.js';
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
    failureIdentity:
      overrides.failureIdentity ??
      (overrides.failedTests
        ? {
            runner: 'fixture',
            unit: 'test',
            ids: overrides.failedTests,
            complete:
              overrides.failedTests.length === (overrides.failed ?? 0) &&
              overrides.failedTests.every((id) => !/[\/]| > |::|›/.test(id)),
          }
        : undefined),
  };
}


function sampleTask(id:string):MinedTask {return {id,implFiles:[],implPatch:''} as unknown as MinedTask;}
describe('regression identity comparison',()=>{
  it('detects a replaced failure even when the failure count stays equal', () => {
    const base = summary({
      failed: 1,
      passed: 3,
      exitCode: 1,
      failedTests: ['A'],
    });
    const final = summary({
      failed: 1,
      passed: 3,
      exitCode: 1,
      failedTests: ['B'],
    });
    expect(detectRegressions(base, final)).toEqual(['B']);
  });

  it.each([
    [['A', 'B'], ['B'], 'none', []],
    [['A'], ['A'], 'none', []],
    [['A', 'B'], ['C'], 'detected', ['C']],
  ] as const)('compares complete identity sets %j to %j', (before, after, status, names) => {
    const result = assessRegressions(
      summary({
        exitCode: 1,
        failed: before.length,
        failedTests: [...before],
      }),
      summary({ exitCode: 1, failed: after.length, failedTests: [...after] }),
    );
    expect(result.status).toBe(status);
    expect(result.regressions).toEqual(names);
  });
  it('treats file errors versus individual cases as unknown', () => {
    const base = summary({
      exitCode: 1,
      failed: 1,
      failedTests: ['src/a.test.ts'],
    });
    const final = summary({
      exitCode: 1,
      failed: 1,
      failedTests: ['src/a.test.ts > B'],
    });
    expect(assessRegressions(base, final).status).toBe('unknown');
    const score = scoreRun(sampleTask('repo-1'), {
      patch: '',
      patchFiles: [],
      baseline: base,
      test: final,
    });
    expect(score.regression).toBe(0);
    expect(score.regressionFree).toBe(false);
  });
  it('keeps aggregate count fallback without inventing identities', () => {
    expect(
      assessRegressions(summary({ failed: 1, failedTests: [] }), summary({ exitCode: 1, failed: 2, failedTests: [] }))
        .status,
    ).toBe('detected');
  });
  it('does not compare different runners or truncated identity sets', () => {
    const base = summary({
      exitCode: 1,
      failed: 1,
      failureIdentity: {
        runner: 'vitest',
        unit: 'test',
        ids: ['A'],
        complete: true,
      },
    });
    for (const override of [
      { runner: 'pytest', unit: 'test' as const, ids: ['B'], complete: true },
      { runner: 'vitest', unit: 'test' as const, ids: ['B'], complete: false },
    ])
      expect(assessRegressions(base, summary({ exitCode: 1, failed: 1, failureIdentity: override })).status).toBe(
        'unknown',
      );
  });
});
