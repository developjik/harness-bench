import {describe,expect,it} from 'vitest';
import {assessRegressions,detectRegressions,scoreRun} from '../src/scorer.js';
import {summarizeTestRun} from '../src/testrun.js';
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
  const parseOutput=(stdout:string)=>summarizeTestRun('test',{stdout,stderr:'',code:1,timedOut:false,durationMs:1});
  it('preserves spaces in pytest parameter IDs',()=>{
    const a=parseOutput('FAILED tests/test_a.py::test_x[case A] - assert false\n=== 1 failed, 2 passed in 0.12s ===');
    const b=parseOutput('FAILED tests/test_a.py::test_x[case B] - assert false\n=== 1 failed, 2 passed in 0.12s ===');
    expect(assessRegressions(a,b)).toMatchObject({status:'detected',regressions:['tests/test_a.py::test_x[case B]']});
  });
  it('does not claim complete pytest IDs with ambiguous summary delimiters',()=>{
    expect(parseOutput('FAILED tests/test_a.py::test_x[case - B] - assertion\n=== 1 failed in 0.12s ===').failureIdentity?.complete).toBe(false);
  });
  it.each([
    ' FAIL src/a.test.ts > suite > A\n FAIL src/b.test.ts\n Test Files 2 failed (2)\n Tests 1 failed (1)',
    'FAILED tests/a.py::A - failed\nERROR tests/b.py::B - fixture error\n=== 1 failed, 1 error in 0.12s ==='
  ])('execution errors prevent regression-free credit',text=>{
    const run=parseOutput(text);expect(run.failureIdentity?.complete).toBe(false);
    expect(assessRegressions(run,run).status).toBe('unknown');
  });
  it('includes named Vitest project identity',()=>{
    const parse=(id:string)=>parseOutput(` FAIL |browser| src/a.test.ts > suite > ${id}\n Test Files 1 failed (1)\n Tests 1 failed (1)`);
    expect(assessRegressions(parse('A'),parse('B'))).toMatchObject({status:'detected',regressions:['|browser| src/a.test.ts > suite > B']});
  });

  it.each(['vitest','pytest'])('detects A to B from real %s output', runner=>{
    const parse=(id:string)=>summarizeTestRun(runner,{code:1,timedOut:false,durationMs:1,stderr:'',stdout:runner==='vitest' ? ` FAIL src/a.test.ts > suite > ${id}\n Test Files 1 failed (1)\n Tests 1 failed | 2 passed (3)` : `FAILED tests/test_a.py::${id} - assert false\n=== 1 failed, 2 passed in 0.12s ===`});
    const a=parse('A'), b=parse('B');
    expect(a.failureIdentity?.complete).toBe(true);
    expect(assessRegressions(a,b)).toMatchObject({status:'detected',regressions:[runner==='vitest'?'src/a.test.ts > suite > B':'tests/test_a.py::B']});
    expect(assessRegressions(a,a).status).toBe('none');
    expect(assessRegressions(a,{...b,failedTestsComplete:false}).status).toBe('unknown');
  });
  it('keeps old records without identity metadata unknown',()=>{
    const a=summary({exitCode:1,failed:1,failedTests:['A']});
    const b=summary({exitCode:1,failed:1,failedTests:['B']});
    delete a.failureIdentity; delete b.failureIdentity;
    expect(assessRegressions(a,b).status).toBe('unknown');
  });

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
