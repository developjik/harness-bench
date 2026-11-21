import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError, main, parseArgs, readVersion } from '../src/cli.js';
import type { CliIo } from '../src/cli.js';
import { buildFixtureRepo, createTempDir } from './helpers.js';

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text) => out.push(text), err: (text) => err.push(text), isTTY: false },
    out,
    err,
  };
}

describe('parseArgs', () => {
  it('collects commands, values and boolean flags', () => {
    const parsed = parseArgs([
      'run',
      '--driver',
      'mock,codex',
      '--dry-run',
      '--limit',
      '3',
      '--task',
      'a',
      '--task=b',
      '--json',
    ]);
    expect(parsed.command).toBe('run');
    expect(parsed.values.get('driver')).toEqual(['mock,codex']);
    expect(parsed.values.get('task')).toEqual(['a', 'b']);
    expect(parsed.booleans.has('dry-run')).toBe(true);
    expect(parsed.booleans.has('json')).toBe(true);
    expect(parsed.values.get('limit')).toEqual(['3']);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['mine', '--nope'])).toThrow(UsageError);
  });

  it('rejects value flags without a value', () => {
    expect(() => parseArgs(['mine', '--repo'])).toThrow(/needs a value/);
  });
});

describe('main', () => {
  it('prints the version', async () => {
    const { io, out } = captureIo();
    const code = await main(['--version'], io);
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe(readVersion());
  });

  it('prints help', async () => {
    const { io, out } = captureIo();
    const code = await main(['--help'], io);
    expect(code).toBe(0);
    expect(out.join('')).toContain('harness-bench');
    expect(out.join('')).toContain('mine');
  });

  it('returns 2 for unknown commands', async () => {
    const { io, err } = captureIo();
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(err.join('')).toContain('Unknown command');
  });

  it(
    'mines, lists, runs and reports through the CLI',
    async () => {
      const fixture = buildFixtureRepo();
      const dataDir = createTempDir('hb-cli-');
      try {
        const mine = captureIo();
        const mineCode = await main(
          ['mine', '--repo', fixture.repo.dir, '--data-dir', dataDir, '--store', 'jsonl', '--json'],
          mine.io,
        );
        expect(mineCode).toBe(0);
        const mined = JSON.parse(mine.out.join('')) as { tasks: Array<{ id: string }> };
        expect(mined.tasks).toHaveLength(1);

        const list = captureIo();
        expect(await main(['list', '--data-dir', dataDir, '--json'], list.io)).toBe(0);
        const tasks = JSON.parse(list.out.join('')) as Array<{ id: string }>;
        expect(tasks).toHaveLength(1);

        const run = captureIo();
        const runCode = await main(
          ['run', '--repo', fixture.repo.dir, '--data-dir', dataDir, '--store', 'jsonl', '--driver', 'mock', '--json'],
          run.io,
        );
        expect(runCode).toBe(0);
        const results = JSON.parse(run.out.join('')) as Array<{ test: { failed: number }; score: { total: number } }>;
        expect(results).toHaveLength(1);
        expect(results[0]?.test.failed).toBe(0);
        expect(results[0]?.score.total).toBeGreaterThan(0.9);

        const report = captureIo();
        expect(await main(['report', '--data-dir', dataDir, '--store', 'jsonl'], report.io)).toBe(0);
        expect(report.out.join('')).toContain('MATRIX');

        const outPath = join(createTempDir('hb-html-'), 'report.html');
        const html = captureIo();
        expect(
          await main(
            ['report', '--data-dir', dataDir, '--store', 'jsonl', '--format', 'html', '--out', outPath],
            html.io,
          ),
        ).toBe(0);
        expect(existsSync(outPath)).toBe(true);
        expect(html.out.join('').trim()).toBe(outPath);
      } finally {
        fixture.repo.cleanup();
      }
    },
    300_000,
  );

  it(
    'returns 1 when there is nothing to run',
    async () => {
      const { io, err } = captureIo();
      const code = await main(['run', '--data-dir', createTempDir('hb-empty-'), '--store', 'jsonl'], io);
      expect(code).toBe(1);
      expect(err.join('')).toContain('No mined tasks');
    },
    60_000,
  );

  it(
    'reports the mined plan in a dry run without storing',
    async () => {
      const fixture = buildFixtureRepo();
      const dataDir = createTempDir('hb-dry-');
      try {
        const { io, out } = captureIo();
        expect(
          await main(['mine', '--repo', fixture.repo.dir, '--data-dir', dataDir, '--dry-run'], io),
        ).toBe(0);
        expect(out.join('')).toContain('Dry run');
        expect(existsSync(join(dataDir, 'tasks.jsonl'))).toBe(false);
      } finally {
        fixture.repo.cleanup();
      }
    },
    60_000,
  );
});
