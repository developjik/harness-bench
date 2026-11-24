import { describe, expect, it } from 'vitest';
import { appendOutputChunk, OUTPUT_CAP, parseFailedTests, runShellCommand, summarizeTestRun } from '../src/testrun.js';
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

const CARGO_WORKSPACE_FAIL = `
   Compiling crate-a v0.1.0 (/ws/crate-a)
   Compiling crate-b v0.1.0 (/ws/crate-b)
     Running unittests src/lib.rs (target/debug/deps/crate_a-1a2b)

running 3 tests
test a_one ... ok
test a_two ... ok
test a_three ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/lib.rs (target/debug/deps/crate_b-3c4d)

running 3 tests
test b_one ... ok
test b_two ... FAILED
test b_three ... FAILED

failures:
    b_two
    b_three

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

error: test failed, to rerun pass `-p crate-b --lib`
`;

const CARGO_EMPTY_CRATE = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 2 tests
test a_one ... ok
test a_two ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`;

const CARGO_WITH_DOCTEST = `
     Running unittests src/lib.rs (target/debug/deps/crate_a-1a2b)

running 2 tests
test a_one ... ok
test a_two ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

   Doc-tests crate-a

running 1 test
test src/lib.rs - add (line 10) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`;

const CARGO_COMPILE_FAIL = `
running 3 tests
test a_one ... ok
test a_two ... ok
test a_three ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

   Compiling crate-b v0.1.0 (/ws/crate-b)
error[E0308]: mismatched types
  --> crate-b/src/lib.rs:4:18
error: could not compile `crate-b` (lib test) due to 1 previous error
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

  it('sums every cargo test-result line across a workspace', () => {
    const summary = summarizeTestRun('cargo test --workspace', {
      code: 101,
      stdout: CARGO_WORKSPACE_FAIL,
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    expect(summary.countsKnown).toBe(true);
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(2);
    expect(summary.total).toBe(6);
    expect(summary.countsUncertain).toBeUndefined();
  });

  it('ignores an empty crate result when summing the workspace', () => {
    const summary = summarizeTestRun('cargo test', {
      code: 0,
      stdout: CARGO_EMPTY_CRATE,
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(2);
  });

  it('counts doc-tests once as their own suite, not as duplicates of unit tests', () => {
    const summary = summarizeTestRun('cargo test', {
      code: 0,
      stdout: CARGO_WITH_DOCTEST,
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(3);
  });

  it('marks counts uncertain when the exit code fails with no recorded failures', () => {
    const summary = summarizeTestRun('cargo test --workspace', {
      code: 101,
      stdout: CARGO_COMPILE_FAIL,
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.countsUncertain).toBe(true);
    expect(summary.note).toContain('101');
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
  it('captures stdout and exit code without marking short output truncated', async () => {
    const dir = createTempDir();
    const result = await runShellCommand(dir, 'echo hello && exit 3', 10_000);
    expect(result.stdout).toContain('hello');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.outputCapture?.stdout).toMatchObject({ truncated: false, retainedRange: 'complete' });
  });

  it('retains a long stdout tail with the final test counts within the byte cap', async () => {
    const dir = createTempDir();
    const command = `node -e 'process.stdout.write("x".repeat(450000) + "\\n2 passed, 2 total\\n")'`;
    const result = await runShellCommand(dir, command, 10_000);
    const summary = summarizeTestRun(command, result);

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(result.stdout.endsWith('2 passed, 2 total\n')).toBe(true);
    expect(summary.passed).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.countsKnown).toBe(true);
    expect(summary.outputCapture?.stdout).toMatchObject({ truncated: true, retainedRange: 'tail', limitBytes: OUTPUT_CAP });
    expect(summary.failedTestsComplete).toBe(false);
    expect(summary.note).toContain('stdout tail');
  });

  it('retains the final failure summary from long stderr and marks names incomplete', async () => {
    const dir = createTempDir();
    const command = `node -e 'process.stderr.write("x".repeat(450000) + "\\nFAIL src/late.test.ts > suite > final failure\\n2 failed, 2 total\\n"); process.exitCode = 1'`;
    const result = await runShellCommand(dir, command, 10_000);
    const summary = summarizeTestRun(command, result);

    expect(result.stdout).toBe('');
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(result.stderr).toContain('2 failed, 2 total');
    expect(summary.countsKnown).toBe(true);
    expect(summary.failed).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.failedTests).toContain('src/late.test.ts > suite > final failure');
    expect(summary.outputCapture?.stderr).toMatchObject({ truncated: true, retainedRange: 'tail', limitBytes: OUTPUT_CAP });
    expect(summary.failedTestsComplete).toBe(false);
    expect(summary.note).toContain('failed test names may be incomplete');
  });

  it('keeps a single chunk larger than the cap bounded while preserving its tail', () => {
    const chunk = Buffer.alloc(OUTPUT_CAP + 4, 0x78);
    chunk.write('tail', chunk.length - 4);

    const result = appendOutputChunk(Buffer.alloc(0), chunk);

    expect(result.truncated).toBe(true);
    expect(result.buffer.length).toBe(OUTPUT_CAP);
    expect(result.buffer.toString('utf8').endsWith('tail')).toBe(true);
  });

  it('kills a command after the timeout', async () => {
    const dir = createTempDir();
    const result = await runShellCommand(dir, 'sleep 5', 500);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.durationMs).toBeLessThan(4_000);
  });
});
