import { describe, expect, it } from 'vitest';
import { parseFailedTests, runShellCommand, summarizeTestRun } from '../src/testrun.js';
import { createTempDir } from './helpers.js';

const VITEST_FAIL = `
 FAIL  src/math.test.ts > math > multiplies
AssertionError: expected 6 to be 7

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
   Duration  412ms
`;

const JEST_FAIL = `
FAIL src/sum.test.js
  ● sum › adds two numbers

    expect(received).toBe(expected)

Tests:       1 failed, 2 passed, 3 total
`;

const NODE_TEST_FAIL = `
▶ math
  ✖ multiplies numbers (1.2ms)
  ✔ adds numbers (0.4ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1
`;

const CARGO_FAIL = `
running 3 tests
test math::adds ... ok
test math::multiplies ... FAILED

failures:
    math::multiplies

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
`;

const PYTEST_FAIL = `
=========================== short test summary info ============================
FAILED tests/test_math.py::test_multiplies - assert 6 == 7
========================= 1 failed, 2 passed in 0.12s ==========================
`;

const GO_FAIL = `--- FAIL: TestMul (0.00s)
    math_test.go:14: got 6 want 7
FAIL
FAIL\texample.com/math\t0.003s
`;

describe('summarizeTestRun', () => {
  it('parses a vitest summary', () => {
    const summary = summarizeTestRun('vitest run', { code: 1, stdout: VITEST_FAIL, stderr: '', timedOut: false, durationMs: 500 });
    expect(summary.countsKnown).toBe(true);
    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(3);
    expect(summary.total).toBe(4);
    expect(summary.passRate).toBeCloseTo(0.75);
    expect(summary.failedTests.join(' ')).toContain('multiplies');
  });

  it('parses a jest summary', () => {
    const summary = summarizeTestRun('jest', { code: 1, stdout: JEST_FAIL, stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(2);
    expect(summary.total).toBe(3);
  });

  it('parses the node test runner output', () => {
    const summary = summarizeTestRun('node --test', { code: 1, stdout: NODE_TEST_FAIL, stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.total).toBe(2);
  });

  it('parses cargo output', () => {
    const summary = summarizeTestRun('cargo test', { code: 1, stdout: CARGO_FAIL, stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failedTests).toEqual(['math::multiplies']);
  });

  it('parses pytest output', () => {
    const summary = summarizeTestRun('pytest', { code: 1, stdout: PYTEST_FAIL, stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failedTests).toEqual(['tests/test_math.py::test_multiplies']);
  });

  it('parses go test output', () => {
    const summary = summarizeTestRun('go test', { code: 1, stdout: GO_FAIL, stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.failedTests).toContain('TestMul');
  });

  it('falls back to the exit code when no counts are present', () => {
    const summary = summarizeTestRun('make test', { code: 0, stdout: 'all good', stderr: '', timedOut: false, durationMs: 10 });
    expect(summary.countsKnown).toBe(false);
    expect(summary.passRate).toBe(1);
    const failed = summarizeTestRun('make test', { code: 2, stdout: 'boom', stderr: '', timedOut: false, durationMs: 10 });
    expect(failed.passRate).toBe(0);
  });
});

describe('parseFailedTests', () => {
  it('collects failing names without duplicates', () => {
    const names = parseFailedTests(`${VITEST_FAIL}\n${NODE_TEST_FAIL}\n${GO_FAIL}`);
    expect(names).toContain('src/math.test.ts > math > multiplies');
    expect(names).toContain('multiplies numbers');
    expect(names).toContain('TestMul');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('runShellCommand', () => {
  it('captures stdout and exit code', async () => {
    const dir = createTempDir();
    const result = await runShellCommand(dir, 'echo hello && exit 3', 10_000);
    expect(result.stdout).toContain('hello');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('kills a command after the timeout', async () => {
    const dir = createTempDir();
    const result = await runShellCommand(dir, 'sleep 5', 500);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.durationMs).toBeLessThan(4_000);
  });
});
