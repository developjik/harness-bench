/** Runs the repository's test command and turns its output into a TestSummary. */

import { spawn } from 'node:child_process';
import type { TestSummary } from './types.js';
import { nowIso, truncateTail } from './util.js';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const OUTPUT_CAP = 400_000;

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export async function runShellCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length < OUTPUT_CAP) stdout += text;
      } else if (stderr.length < OUTPUT_CAP) {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, Math.max(1_000, timeoutMs));

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        stdout: truncateTail(stdout, OUTPUT_CAP),
        stderr: truncateTail(stderr, OUTPUT_CAP),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (error) => {
      append('err', Buffer.from(String(error)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  known: boolean;
}

const COUNT_KEYS = ['passed', 'failed', 'skipped', 'ignored', 'total'] as const;

function countsFromSummaryLine(line: string): Counts | null {
  const counts: Counts = { passed: -1, failed: -1, skipped: 0, total: -1, known: false };
  let matched = false;
  for (const key of COUNT_KEYS) {
    const pattern = new RegExp(`(\\d+)\\s+${key}\\b`, 'i');
    const match = pattern.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    matched = true;
    if (key === 'passed') counts.passed = value;
    else if (key === 'failed') counts.failed = value;
    else if (key === 'skipped' || key === 'ignored') counts.skipped += value;
    else if (key === 'total') counts.total = value;
  }
  // Jest prints "Tests: 1 failed, 2 passed, 3 total" and vitest "Tests  1 failed | 2 passed (3)".
  const parenthesized = /\((\d+)\)\s*$/.exec(line);
  if (counts.total < 0 && parenthesized) counts.total = Number(parenthesized[1]);
  if (!matched) return null;
  if (counts.passed < 0) counts.passed = 0;
  if (counts.failed < 0) counts.failed = 0;
  if (counts.total < 0) counts.total = counts.passed + counts.failed + counts.skipped;
  counts.known = true;
  return counts;
}

function findCounts(text: string): Counts | null {
  const lines = text.split('\n');

  // node:test / TAP: "# pass 3" · "ℹ fail 1"
  const nodePass = /(?:^|\n)\s*[#ℹ]\s*pass\s+(\d+)\s*(?:\n|$)/.exec(text);
  if (nodePass) {
    const nodeFail = /(?:^|\n)\s*[#ℹ]\s*fail\s+(\d+)\s*(?:\n|$)/.exec(text);
    const nodeSkip = /(?:^|\n)\s*[#ℹ]\s*skipped\s+(\d+)\s*(?:\n|$)/.exec(text);
    const passed = Number(nodePass[1]);
    const failed = nodeFail ? Number(nodeFail[1]) : 0;
    const skipped = nodeSkip ? Number(nodeSkip[1]) : 0;
    return { passed, failed, skipped, total: passed + failed + skipped, known: true };
  }

  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out"
  const cargo = /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/i.exec(text);
  if (cargo) {
    const passed = Number(cargo[1]);
    const failed = Number(cargo[2]);
    const skipped = Number(cargo[3]);
    return { passed, failed, skipped, total: passed + failed + skipped, known: true };
  }

  // Lines that look like a suite summary, newest last (some runners print per-file summaries too).
  const candidates = lines.filter((line) => {
    if (/^\s*$/.test(line)) return false;
    if (/^\s*[✓✔×✗·]/.test(line)) return false;
    if (/^\s*FAIL\s/.test(line)) return false;
    return /(\d+\s+(passed|failed))|Tests?:/i.test(line);
  });

  // Prefer the global "Tests" line (vitest/jest), else the last summary-ish line.
  const global = [...candidates].reverse().find((line) => /^\s*(Tests?|Test Files)\b/i.test(line) && !/Test Files/i.test(line));
  const chosen = global ?? candidates[candidates.length - 1];
  if (chosen) {
    const counts = countsFromSummaryLine(chosen);
    if (counts) return counts;
  }

  // Aggregate per-file lines such as "1 passed (1)" repeated per file.
  const perFile = candidates.filter((line) => /^\s*\d+\s+passed/i.test(line) || /^\s*(\d+\s+failed)/i.test(line));
  if (perFile.length > 1) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const line of perFile) {
      const counts = countsFromSummaryLine(line);
      if (!counts) continue;
      passed += counts.passed;
      failed += counts.failed;
      skipped += counts.skipped;
    }
    return { passed, failed, skipped, total: passed + failed + skipped, known: true };
  }
  return null;
}

export function parseFailedTests(text: string): string[] {
  const names: string[] = [];
  const add = (raw: string): void => {
    const name = raw
      .replace(/\s*\(\d+(\.\d+)?\s*(ms|s)\)\s*$/, '')
      .replace(/\s+\d+(\.\d+)?\s*(ms|s)$/, '')
      .trim();
    if (name.length === 0 || name.length > 300) return;
    if (names.includes(name)) return;
    names.push(name);
  };

  for (const line of text.split('\n')) {
    const cleaned = line.replace(/\s+$/, '');
    let match: RegExpExecArray | null;

    if ((match = /^\s*FAIL\s+(\S+?)(?:\s+>\s+(.+))?$/.exec(cleaned))) {
      add(`${match[1]}${match[2] ? ` > ${match[2]}` : ''}`);
      // jest/vitest also list the failing case separately; keep both.
      continue;
    }
    if ((match = /^\s*[×✗✖]\s+(.+)$/.exec(cleaned))) {
      add(match[1] ?? '');
      continue;
    }
    if ((match = /^\s*●\s+(.+)$/.exec(cleaned))) {
      const name = match[1] ?? '';
      if (!/console|deprecation/i.test(name)) add(name);
      continue;
    }
    if ((match = /^FAILED\s+(\S+?)(?:::(\S+))?(?:\s+-\s+.*)?$/.exec(cleaned))) {
      add(match[2] ? `${match[1]}::${match[2]}` : (match[1] ?? ''));
      continue;
    }
    if ((match = /^not ok \d+\s+-\s+(.+?)(?:\s+#.*)?$/.exec(cleaned))) {
      add(match[1] ?? '');
      continue;
    }
    if ((match = /^✖\s+(.+)$/.exec(cleaned))) {
      add(match[1] ?? '');
      continue;
    }
    if ((match = /^--- FAIL:\s+(\S+)/.exec(cleaned))) {
      add(match[1] ?? '');
      continue;
    }
    if ((match = /^test\s+(\S+)\s+\.\.\.\s+FAILED/.exec(cleaned))) {
      add(match[1] ?? '');
    }
  }
  return names.slice(0, 200);
}

export function summarizeTestRun(command: string, result: CommandResult): TestSummary {
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const counts = findCounts(combined);
  const failedTests = parseFailedTests(combined);
  const base = {
    command,
    ran: true,
    exitCode: result.code,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };

  if (counts) {
    const total = Math.max(counts.total, counts.passed + counts.failed);
    const passRate = total === 0 ? (result.code === 0 ? 1 : 0) : counts.passed / total;
    return {
      ...base,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      total,
      passRate,
      failedTests,
      countsKnown: true,
    };
  }

  const passRate = result.timedOut ? 0 : result.code === 0 ? 1 : 0;
  return {
    ...base,
    passed: 0,
    failed: result.code === 0 ? 0 : Math.max(1, failedTests.length),
    skipped: 0,
    total: 0,
    passRate,
    failedTests,
    countsKnown: false,
  };
}

export function emptyTestSummary(command: string, reason: string): TestSummary {
  return {
    command,
    ran: false,
    exitCode: null,
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    passRate: 0,
    failedTests: [],
    countsKnown: false,
    durationMs: 0,
    note: reason,
  };
}

export interface TestRun {
  summary: TestSummary;
  output: string;
  startedAt: string;
}

export async function runTests(
  cwd: string,
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<TestRun> {
  const result = await runShellCommand(cwd, command, timeoutMs, env);
  return {
    summary: summarizeTestRun(command, result),
    output: stripAnsi(`${result.stdout}\n${result.stderr}`),
    startedAt: nowIso(),
  };
}
