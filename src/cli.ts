/** Command-line interface: mine, run, report, list, doctor. */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_DRIVER_IDS, createDrivers, parseMockMode, whichBinary } from './drivers/index.js';
import { mineTasks } from './miner.js';
import { compareSelections, readSelectionGraph } from './selection.js';
import { renderHtml, renderJson, renderTerminal, summarizeMeta, writeHtmlReport } from './report.js';
import { runMatrix } from './runner.js';
import {
  detectStoreKind,
  ensureDir,
  loadResults,
  openTaskStore,
  saveResults,
  timestampSlug,
  type StoreKind,
} from './store.js';
import type { MinedTask } from './types.js';
import { DEFAULT_DATA_DIR, VERSION, padEndVisible } from './util.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  isTTY?: boolean;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdout.isTTY),
};

export function readVersion(): string {
  for (const relative of ['../../package.json', '../package.json']) {
    try {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return VERSION;
}

export class UsageError extends Error {}

const VALUE_FLAGS = new Set([
  'repo',
  'data-dir',
  'limit',
  'max-tasks',
  'since',
  'test-cmd',
  'store',
  'max-diff-lines',
  'driver',
  'timeout',
  'test-timeout',
  'mock-mode',
  'task',
  'format',
  'out',
  'damon-backend',
  'prompt-template',
  'graph-snapshot',
  'seed',
  'count',
]);

const BOOLEAN_FLAGS = new Set([
  'json',
  'dry-run',
  'help',
  'version',
  'baseline',
  'no-baseline',
  'keep-worktree',
  'link-deps',
  'no-link-deps',
  'no-color',
  'force',
  'quiet',
]);

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: null, positionals: [], values: new Map(), booleans: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '-h') {
      parsed.booleans.add('help');
      continue;
    }
    if (token === '-v') {
      parsed.booleans.add('version');
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        pushValue(parsed, body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        parsed.booleans.add(body);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) throw new UsageError(`--${body} needs a value`);
        pushValue(parsed, body, next);
        index += 1;
        continue;
      }
      throw new UsageError(`Unknown flag --${body}. Try --help.`);
    }
    if (parsed.command === null) parsed.command = token;
    else parsed.positionals.push(token);
  }
  return parsed;
}

function pushValue(parsed: ParsedArgs, name: string, value: string): void {
  if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown flag --${name}. Try --help.`);
  const list = parsed.values.get(name) ?? [];
  list.push(value);
  parsed.values.set(name, list);
}

function last(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function all(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

function numberFlag(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = last(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} must be a positive number, got "${raw}"`);
  return value;
}

function storeFlag(parsed: ParsedArgs, dataDir: string): StoreKind {
  const raw = last(parsed, 'store');
  if (raw === undefined) return detectStoreKind(dataDir);
  if (raw !== 'sqlite' && raw !== 'jsonl') throw new UsageError(`--store must be sqlite or jsonl, got "${raw}"`);
  return raw;
}

function resolveRepo(parsed: ParsedArgs): string {
  return resolve(last(parsed, 'repo') ?? '.');
}

function resolveDataDir(parsed: ParsedArgs, repo?: string): string {
  const explicit = last(parsed, 'data-dir');
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  if (existsSync(DEFAULT_DATA_DIR)) return resolve(DEFAULT_DATA_DIR);
  return join(repo ?? resolve('.'), DEFAULT_DATA_DIR);
}

function wantsJson(parsed: ParsedArgs): boolean {
  return parsed.booleans.has('json');
}

function colorEnabled(parsed: ParsedArgs, io: CliIo): boolean {
  if (parsed.booleans.has('no-color')) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(io.isTTY);
}

const HELP = `harness-bench ${VERSION} — benchmark coding-agent harnesses on your own repository

USAGE
  harness-bench <command> [options]

COMMANDS
  mine      Mine implementation+test commits from a local git repository into benchmark tasks
  run       Run tasks against one or more harness drivers in isolated git worktrees
  report    Print the score matrix, or write a static HTML report
  list      List mined tasks
  doctor    Show which harness binaries are available
  select    Compare offline graph-weighted selection against existing mine order

GLOBAL OPTIONS
  --help, -h              Show this help
  --version, -v           Print the version
  --json                  Machine-readable output
  --no-color              Disable ANSI colours
  --data-dir <dir>        Runtime data directory (default: ./.harness-bench, else <repo>/.harness-bench)

mine OPTIONS
  --repo <path>           Local git repository to mine (default: .)
  --limit <n>             Commits to scan, newest first (default: 200)
  --max-tasks <n>         Maximum tasks to keep from this scan (default: 25)
  --since <date>          Only commits after this ISO date
  --test-cmd <command>    Test command to record (default: inferred from the repo)
  --max-diff-lines <n>    Skip commits larger than this many changed lines (default: 1200)
  --store <sqlite|jsonl>  Task store backend (default: sqlite)
  --dry-run               Show what would be mined without writing anything

select OPTIONS (experimental, offline, no drivers)
  --repo <path>           Clean repository matching the graph snapshot HEAD
  --graph-snapshot <json> Snapshot from scripts/export-selection-graph.mjs
  --limit <n>             Same commit scan limit as mine (default: 200)
  --max-tasks <n>         Fixed candidate pool bound (default: 25)
  --count <n>             Tasks selected by each method (default: 5)
  --seed <uint32>         Weighted sampling seed (default: 1)
  --out <json>            Write full comparison JSON (otherwise stdout)
  --test-cmd <command>    Mining metadata only; this command never executes it

run OPTIONS
  --repo <path>           Repository that holds the mined commits (default: .)
  --driver <ids>          Comma-separated drivers: ${ALL_DRIVER_IDS.join(', ')} (default: mock)
  --task <id>             Run only these task ids (repeatable)
  --limit <n>             Run at most n mined tasks (newest first)
  --timeout <seconds>     Wall-clock limit per harness run (default: 600)
  --test-timeout <s>      Wall-clock limit per test command (default: 600)
  --dry-run               Use the mock driver and skip starting real harness binaries
  --mock-mode <mode>      oracle | partial | noop (default: oracle)
  --no-baseline           Skip the baseline test run on the prepared base
  --keep-worktree         Keep worktrees after the run (useful for debugging)
  --no-link-deps          Do not symlink node_modules/.venv from the repo into the worktree
  --damon-backend <id>    Backend for the damon driver (default: claude)
  --store <sqlite|jsonl>  Task store backend (default: auto-detect)

report OPTIONS
  --format <table|html|json>  Output format (default: table)
  --out <path>                HTML output path (default: reports/harness-bench-<timestamp>.html)
  --task <id>                 Only include these task ids (repeatable)

EXAMPLES
  harness-bench mine --repo . --limit 300
  harness-bench run --repo . --driver mock --dry-run
  harness-bench run --repo . --driver claude-code,codex --timeout 900
  harness-bench report --format html
  npx -y @developjik/harness-bench mine --repo ~/code/my-app --test-cmd "npm test --silent"

HOW A RUN WORKS
  1. A worktree is created at the commit before the mined change.
  2. Only the test hunks from that change are applied; the implementation is missing.
  3. The harness is asked to make the tests pass.
  4. The patch it leaves behind is scored: tests (60%), similarity to the reference
     diff (30%), and no regression against the prepared base (10%).
`;

function printMineTable(tasks: MinedTask[], skipped: Array<{ sha: string; reason: string }>, io: CliIo): void {
  if (tasks.length === 0) {
    io.out('No tasks mined.\n');
  } else {
    const header = `${padEndVisible('task', 30)}${padEndVisible('commit', 11)}${padEndVisible('tests', 7)}${padEndVisible('impl', 6)}${padEndVisible('lines', 12)}prompt`;
    io.out(`${header}\n${'─'.repeat(Math.min(140, header.length))}\n`);
    for (const task of tasks) {
      const subject = (task.commitMessage.split('\n')[0] ?? '').slice(0, 70);
      const lines = `+${task.goldStats.added}/-${task.goldStats.removed}`;
      io.out(
        `${padEndVisible(task.id, 30)}${padEndVisible(task.targetCommit.slice(0, 8), 11)}${padEndVisible(String(task.testFiles.length), 7)}${padEndVisible(String(task.implFiles.length), 6)}${padEndVisible(lines, 12)}${subject}\n`,
      );
    }
  }
  if (skipped.length > 0) {
    io.out(`\nSkipped ${skipped.length} commit(s):\n`);
    for (const record of skipped.slice(0, 12)) io.out(`  ${record.sha}  ${record.reason}\n`);
    if (skipped.length > 12) io.out(`  … ${skipped.length - 12} more\n`);
  }
  io.out('\n');
}

async function commandMine(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const repo = resolveRepo(parsed);
  const dataDir = resolveDataDir(parsed, repo);
  const storeKind = storeFlag(parsed, dataDir);
  const report = mineTasks({
    repo,
    limit: numberFlag(parsed, 'limit', 200),
    maxTasks: numberFlag(parsed, 'max-tasks', 25),
    since: last(parsed, 'since'),
    testCommand: last(parsed, 'test-cmd'),
    maxDiffLines: numberFlag(parsed, 'max-diff-lines', 1200),
    promptTemplate: last(parsed, 'prompt-template'),
  });

  if (wantsJson(parsed)) {
    io.out(
      `${JSON.stringify(
        {
          repo: report.repo,
          repoName: report.repoName,
          head: report.head,
          testCommand: report.testCommand,
          scanned: report.scanned,
          dryRun: parsed.booleans.has('dry-run'),
          tasks: report.tasks.map((task) => ({
            id: task.id,
            baseCommit: task.baseCommit,
            targetCommit: task.targetCommit,
            testFiles: task.testFiles,
            implFiles: task.implFiles,
            testCommand: task.testCommand,
            goldStats: task.goldStats,
            prompt: task.prompt,
          })),
          skipped: report.skipped,
        },
        null,
        2,
      )}\n`,
    );
    if (parsed.booleans.has('dry-run') || report.tasks.length === 0) return 0;
  } else {
    io.out(`\nrepo         ${report.repoName} (${report.repo})\n`);
    io.out(`test command ${report.testCommand}\n`);
    io.out(`scanned      ${report.scanned} commit(s)\n\n`);
    printMineTable(report.tasks, report.skipped, io);
    if (parsed.booleans.has('dry-run')) {
      io.out(`Dry run: ${report.tasks.length} task(s) found, nothing was written.\n`);
      return 0;
    }
    if (report.tasks.length === 0) {
      io.out('Nothing to store. Try a larger --limit or pass --test-cmd.\n');
      return 0;
    }
  }

  const store = openTaskStore(storeKind, dataDir);
  const saved = store.save(report.tasks);
  const storePath = store.path;
  store.close();
  if (!wantsJson(parsed)) {
    io.out(`Stored ${report.tasks.length} task(s) in ${storePath} (${storeKind}) — ${saved.inserted} new, ${saved.updated} updated.\n`);
  }
  return 0;
}

async function commandSelect(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const repo = resolveRepo(parsed);
  const file = last(parsed, 'graph-snapshot');
  if (!file) throw new UsageError('--graph-snapshot is required');
  const { gitOrThrow } = await import('./git.js');
  if (gitOrThrow(repo, ['status', '--porcelain', '--untracked-files=normal']).trim()) throw new UsageError('select requires a clean checkout');
  const { assertFullSelectionClone } = await import('./selection-safety.js');
  try { assertFullSelectionClone(repo); } catch (error) { throw new UsageError((error as Error).message); }
  const head = gitOrThrow(repo, ['rev-parse', 'HEAD']).trim();
  const graph = readSelectionGraph(resolve(file), repo, head);
  const pool = mineTasks({ repo, limit: numberFlag(parsed, 'limit', 200), maxTasks: numberFlag(parsed, 'max-tasks', 25), testCommand: last(parsed, 'test-cmd'), maxDiffLines: numberFlag(parsed, 'max-diff-lines', 1200), since: last(parsed, 'since') });
  const rawSeed = last(parsed, 'seed') ?? '1';
  if (!/^\d+$/.test(rawSeed)) throw new UsageError('--seed must be uint32');
  const result = compareSelections(pool.tasks, graph, numberFlag(parsed, 'count', 5), Number(rawSeed));
  if (gitOrThrow(repo, ['rev-parse', 'HEAD']).trim() !== head || gitOrThrow(repo, ['status', '--porcelain', '--untracked-files=normal']).trim()) throw new UsageError('checkout changed during selection');
  const json = JSON.stringify(result, null, 2) + '\n';
  const out = last(parsed, 'out');
  if (out) {
    const { writeFileSync } = await import('node:fs');
    // Exclusive create avoids clobbering a snapshot or source file.
    writeFileSync(resolve(out), json, { flag: 'wx' });
    io.out(resolve(out) + '\n');
  } else io.out(json);
  return 0;
}

function commandList(parsed: ParsedArgs, io: CliIo): number {
  const dataDir = resolveDataDir(parsed);
  const storeKind = storeFlag(parsed, dataDir);
  const store = openTaskStore(storeKind, dataDir);
  const tasks = store.list();
  const storePath = store.path;
  store.close();
  if (wantsJson(parsed)) {
    io.out(`${JSON.stringify(tasks, null, 2)}\n`);
    return 0;
  }
  io.out(`\n${tasks.length} task(s) in ${storePath} (${storeKind})\n\n`);
  if (tasks.length === 0) {
    io.out('Run `harness-bench mine --repo <path>` first.\n');
    return 0;
  }
  const header = `${padEndVisible('task', 30)}${padEndVisible('repo', 18)}${padEndVisible('commit', 11)}${padEndVisible('tests', 7)}${padEndVisible('impl', 6)}mined`;
  io.out(`${header}\n${'─'.repeat(header.length)}\n`);
  for (const task of tasks) {
    io.out(
      `${padEndVisible(task.id, 30)}${padEndVisible(task.repoName, 18)}${padEndVisible(task.targetCommit.slice(0, 8), 11)}${padEndVisible(String(task.testFiles.length), 7)}${padEndVisible(String(task.implFiles.length), 6)}${task.minedAt}\n`,
    );
  }
  io.out('\n');
  return 0;
}

async function commandRun(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const repo = resolveRepo(parsed);
  const dataDir = resolveDataDir(parsed, repo);
  ensureDir(dataDir);
  const storeKind = storeFlag(parsed, dataDir);
  const store = openTaskStore(storeKind, dataDir);
  let tasks = store.list();
  store.close();

  if (tasks.length === 0) {
    io.err(`No mined tasks in ${dataDir}. Run \`harness-bench mine --repo ${repo}\` first.\n`);
    return 1;
  }

  const requested = all(parsed, 'task');
  if (requested.length > 0) {
    const wanted = new Set(requested);
    tasks = tasks.filter((task) => wanted.has(task.id));
    if (tasks.length === 0) {
      io.err(`None of the requested tasks exist: ${requested.join(', ')}\n`);
      return 1;
    }
  }
  tasks = tasks.slice(0, numberFlag(parsed, 'limit', tasks.length));

  const mockMode = parseMockMode(last(parsed, 'mock-mode'));
  const driverIds = (last(parsed, 'driver') ?? 'mock')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const drivers = createDrivers(driverIds, { mockMode });
  const dryRun = parsed.booleans.has('dry-run');
  const runBaseline = !parsed.booleans.has('no-baseline');
  const damonBackend = last(parsed, 'damon-backend');

  if (!wantsJson(parsed)) {
    io.out(`\n${tasks.length} task(s) × ${drivers.length} driver(s)${dryRun ? ' (dry-run)' : ''}\n`);
    io.out(`data ${dataDir}\n\n`);
  }

  const results = await runMatrix({
    repo,
    dataDir,
    tasks,
    drivers,
    timeoutMs: numberFlag(parsed, 'timeout', 600) * 1000,
    testTimeoutMs: numberFlag(parsed, 'test-timeout', 600) * 1000,
    dryRun,
    mockMode,
    runBaseline,
    keepWorktree: parsed.booleans.has('keep-worktree'),
    linkDeps: !parsed.booleans.has('no-link-deps'),
    extraArgs: [],
    env: damonBackend ? { HARNESS_DAMON_BACKEND: damonBackend } : {},
    onProgress: wantsJson(parsed) || parsed.booleans.has('quiet') ? undefined : (line) => io.out(`${line}\n`),
  });

  saveResults(dataDir, results);

  if (wantsJson(parsed)) {
    io.out(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  const meta = summarizeMeta(results, { dataDir, tasks: tasks.length, version: readVersion() });
  io.out(renderTerminal(results, meta, { color: colorEnabled(parsed, io) }));
  return results.some((result) => result.error) ? 1 : 0;
}

function commandReport(parsed: ParsedArgs, io: CliIo): number {
  const dataDir = resolveDataDir(parsed);
  let results = loadResults(dataDir);
  const requested = all(parsed, 'task');
  if (requested.length > 0) {
    const wanted = new Set(requested);
    results = results.filter((result) => wanted.has(result.taskId));
  }
  let taskCount = 0;
  try {
    const store = openTaskStore(storeFlag(parsed, dataDir), dataDir);
    taskCount = store.list().length;
    store.close();
  } catch {
    taskCount = new Set(results.map((result) => result.taskId)).size;
  }
  const meta = summarizeMeta(results, { dataDir, tasks: taskCount, version: readVersion() });
  const format = last(parsed, 'format') ?? 'table';

  if (format === 'json' || wantsJson(parsed)) {
    io.out(`${renderJson(results, meta)}\n`);
    return 0;
  }
  if (format === 'html') {
    const out = last(parsed, 'out') ?? join('reports', `harness-bench-${timestampSlug()}.html`);
    const path = writeHtmlReport(resolve(out), renderHtml(results, meta));
    io.out(`${path}\n`);
    return 0;
  }
  if (format !== 'table') throw new UsageError(`--format must be table, html or json (got "${format}")`);
  io.out(renderTerminal(results, meta, { color: colorEnabled(parsed, io) }));
  return 0;
}

const DRIVER_BINARIES: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  damon: 'damon',
};

async function commandDoctor(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const dataDir = resolveDataDir(parsed);
  const rows: Array<{ driver: string; available: boolean; hint: string }> = [];
  for (const id of ALL_DRIVER_IDS) {
    if (id === 'mock') {
      rows.push({ driver: 'mock', available: true, hint: 'built in (no tokens)' });
      continue;
    }
    const [driver] = createDrivers([id], {});
    const binary = DRIVER_BINARIES[id] ?? id;
    rows.push({
      driver: id,
      available: await driver.available(),
      hint: whichBinary(binary) ?? `not on PATH (set HARNESS_${id.replace(/-/g, '_').toUpperCase()}_CMD)`,
    });
  }

  if (wantsJson(parsed)) {
    io.out(`${JSON.stringify({ version: readVersion(), node: process.version, dataDir, drivers: rows }, null, 2)}\n`);
    return 0;
  }
  io.out(`\nharness-bench ${readVersion()}\n`);
  io.out(`node   ${process.version}\n`);
  io.out(`git    ${whichBinary('git') ?? 'not found'}\n`);
  io.out(`data   ${dataDir} (${existsSync(dataDir) ? 'exists' : 'missing'})\n\n`);
  io.out(`${padEndVisible('driver', 16)}${padEndVisible('available', 12)}hint\n`);
  io.out(`${'─'.repeat(80)}\n`);
  for (const row of rows) {
    io.out(`${padEndVisible(row.driver, 16)}${padEndVisible(row.available ? 'yes' : 'no', 12)}${row.hint}\n`);
  }
  io.out('\nUse --driver mock for a free dry run; real harnesses need their CLI installed and logged in.\n');
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (parsed.booleans.has('version')) {
    io.out(`${readVersion()}\n`);
    return 0;
  }
  if (parsed.booleans.has('help') || parsed.command === null || parsed.command === 'help') {
    io.out(HELP);
    return 0;
  }

  try {
    switch (parsed.command) {
      case 'mine':
        return await commandMine(parsed, io);
      case 'run':
        return await commandRun(parsed, io);
      case 'report':
        return commandReport(parsed, io);
      case 'list':
        return commandList(parsed, io);
      case 'select':
        return await commandSelect(parsed, io);
      case 'doctor':
        return await commandDoctor(parsed, io);
      default:
        io.err(`Unknown command "${parsed.command}". Try --help.\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    io.err(`error: ${(error as Error).message}\n`);
    return 1;
  }
}
