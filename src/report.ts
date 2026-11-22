/** Terminal matrix and a static HTML artifact for a set of runs. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReportMeta, RunResult } from './types.js';
import {
  ANSI,
  colorize,
  escapeHtml,
  formatDuration,
  formatPercent,
  mean,
  median,
  padEndVisible,
  padStartVisible,
  round,
  scoreBand,
} from './util.js';

export interface ReportOptions {
  color?: boolean;
}

function orderedValues(results: RunResult[], key: (result: RunResult) => string): string[] {
  const seen: string[] = [];
  for (const result of results) {
    const value = key(result);
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}

function statusMark(result: RunResult, color: boolean): string {
  if (result.error) return colorize('✖', ANSI.red, color);
  if (!result.test.ran) return colorize('·', ANSI.gray, color);
  if (result.test.failed === 0 && result.test.exitCode === 0) return colorize('✓', ANSI.green, color);
  return colorize('✗', ANSI.red, color);
}

function scoreLabel(result: RunResult, color: boolean): string {
  if (result.score === undefined) return colorize('—', ANSI.gray, color);
  const text = result.score.total.toFixed(2);
  if (!color) return text;
  const band = scoreBand(result.score.total);
  const code = band === 'good' ? ANSI.green : band === 'ok' ? ANSI.yellow : ANSI.red;
  return colorize(text, code, color);
}

function testsLabel(result: RunResult): string {
  if (!result.test.ran) return 'not run';
  if (!result.test.countsKnown) return result.test.exitCode === 0 ? 'pass' : 'fail';
  return `${result.test.passed}/${result.test.total}${result.test.countsUncertain ? '?' : ''}`;
}

function cellFor(result: RunResult, color: boolean): string {
  return `${scoreLabel(result, color)} ${statusMark(result, color)} ${testsLabel(result)}`;
}

export function renderTerminal(results: RunResult[], meta: ReportMeta, options: ReportOptions = {}): string {
  const color = options.color ?? false;
  const lines: string[] = [];
  const bold = (text: string): string => colorize(text, ANSI.bold, color);
  const dim = (text: string): string => colorize(text, ANSI.dim, color);

  lines.push('');
  lines.push(`${bold('harness-bench')} ${meta.version}  ${dim(meta.generatedAt)}`);
  lines.push(
    `${meta.tasks} task(s) · ${meta.runs} run(s) · ${meta.drivers.length} driver(s) · data ${meta.dataDir}`,
  );
  lines.push('');

  if (results.length === 0) {
    lines.push(dim('No runs recorded yet. Run `harness-bench mine` and `harness-bench run` first.'));
    lines.push('');
    return lines.join('\n');
  }

  const taskIds = orderedValues(results, (result) => result.taskId);
  const drivers = orderedValues(results, (result) => result.driver);
  const byKey = new Map(results.map((result) => [`${result.taskId}\u0000${result.driver}`, result]));

  const headerCells = drivers.map((driver) => driver);
  const taskWidth = Math.max(28, ...taskIds.map((id) => id.length + 2));
  const driverWidths = headerCells.map((header, index) => {
    const cells = taskIds.map((taskId) => {
      const result = byKey.get(`${taskId}\u0000${header}`);
      return (result ? cellFor(result, false) : '—').length;
    });
    return Math.max(header.length, ...cells, 10) + (index === headerCells.length - 1 ? 0 : 2);
  });

  lines.push(bold('MATRIX'));
  const head = [padEndVisible('task', taskWidth), ...headerCells.map((header, i) => padEndVisible(header, driverWidths[i] as number))].join('');
  lines.push(dim(head.replace(/\s+$/, '')));
  lines.push(dim('─'.repeat(Math.min(120, taskWidth + driverWidths.reduce((sum, width) => sum + width, 0)))));

  for (const taskId of taskIds) {
    const cells = drivers.map((driver, index) => {
      const result = byKey.get(`${taskId}\u0000${driver}`);
      const text = result ? cellFor(result, color) : '—';
      return padEndVisible(text, driverWidths[index] as number);
    });
    lines.push(`${padEndVisible(taskId, taskWidth)}${cells.join('')}`.replace(/\s+$/, ''));
  }
  lines.push('');

  lines.push(bold('DRIVER SUMMARY'));
  const summaryHeader = [
    padEndVisible('driver', 16),
    padStartVisible('runs', 6),
    padStartVisible('mean', 7),
    padStartVisible('pass@1', 8),
    padStartVisible('median', 9),
    padStartVisible('files', 7),
    padStartVisible('diff', 7),
    padStartVisible('errors', 8),
  ].join('');
  lines.push(dim(summaryHeader));
  lines.push(dim('─'.repeat(80)));

  for (const driver of drivers) {
    const driverRuns = results.filter((result) => result.driver === driver);
    const scored = driverRuns.filter((result) => result.score !== undefined);
    const meanScore = mean(scored.map((result) => result.score?.total ?? 0));
    const passAt1 = mean(driverRuns.map((result) => (result.score?.allTestsPassed ? 1 : 0)));
    const wall = median(driverRuns.map((result) => result.wallClockMs));
    const files = mean(driverRuns.map((result) => result.filesTouched));
    const diff = mean(scored.map((result) => result.score?.diff ?? 0));
    const errors = driverRuns.filter((result) => result.error).length;
    const row = [
      padEndVisible(driver, 16),
      padStartVisible(String(driverRuns.length), 6),
      padStartVisible(scored.length > 0 ? meanScore.toFixed(2) : '—', 7),
      padStartVisible(scored.length > 0 ? formatPercent(passAt1) : '—', 8),
      padStartVisible(formatDuration(wall), 9),
      padStartVisible(files.toFixed(1), 7),
      padStartVisible(diff.toFixed(2), 7),
      padStartVisible(String(errors), 8),
    ].join('');
    lines.push(row);
  }
  lines.push('');

  const problems = results.filter(
    (result) => result.error || (result.score && !result.score.regressionFree) || result.testFilesTouched.length > 0,
  );
  if (problems.length > 0) {
    lines.push(bold('NOTES'));
    for (const result of problems) {
      const labels: string[] = [];
      if (result.error) labels.push(`error: ${result.error}`);
      if (result.score && !result.score.regressionFree) {
        labels.push(`regressions: ${result.score.regressions.join('; ')}`);
      }
      if (result.testFilesTouched.length > 0) labels.push(`edited tests: ${result.testFilesTouched.join(', ')}`);
      lines.push(`  ${result.taskId} × ${result.driver} — ${labels.join(' | ')}`);
    }
    lines.push('');
  }

  lines.push(
    dim('score = 0.60·tests solved (share of initially failing tests that now pass) + 0.30·diff similarity'),
  );
  lines.push(dim('        (file F1 / changed-line Jaccard) + 0.10·no-regression against the prepared base'));
  lines.push(dim('✓ all tests pass   ✗ tests fail   ✖ harness error   · tests not run'));
  lines.push('');
  return lines.join('\n');
}

export interface HtmlReportOptions {
  title?: string;
}

export function renderHtml(results: RunResult[], meta: ReportMeta, options: HtmlReportOptions = {}): string {
  const title = options.title ?? 'harness-bench report';
  const drivers = orderedValues(results, (result) => result.driver);
  const taskIds = orderedValues(results, (result) => result.taskId);
  const byKey = new Map(results.map((result) => [`${result.taskId}\u0000${result.driver}`, result]));
  const maxScore = results.reduce((max, result) => Math.max(max, result.score?.total ?? 0), 0);

  const summaryRows = drivers
    .map((driver) => {
      const driverRuns = results.filter((result) => result.driver === driver);
      const scored = driverRuns.filter((result) => result.score !== undefined);
      const meanScore = mean(scored.map((result) => result.score?.total ?? 0));
      return `<tr>
        <th scope="row">${escapeHtml(driver)}</th>
        <td class="num">${driverRuns.length}</td>
        <td class="num strong">${scored.length > 0 ? meanScore.toFixed(2) : '—'}</td>
        <td class="num">${scored.length > 0 ? formatPercent(mean(driverRuns.map((run) => (run.score?.allTestsPassed ? 1 : 0)))) : '—'}</td>
        <td class="num">${formatDuration(median(driverRuns.map((run) => run.wallClockMs)))}</td>
        <td class="num">${mean(driverRuns.map((run) => run.filesTouched)).toFixed(1)}</td>
        <td class="num">${mean(scored.map((run) => run.score?.diff ?? 0)).toFixed(2)}</td>
        <td class="num">${driverRuns.filter((run) => run.error).length}</td>
      </tr>`;
    })
    .join('\n');

  const matrixHead = drivers.map((driver) => `<th class="num">${escapeHtml(driver)}</th>`).join('');
  const matrixRows = taskIds
    .map((taskId) => {
      const cells = drivers
        .map((driver) => {
          const result = byKey.get(`${taskId}\u0000${driver}`);
          if (!result) return '<td class="num muted">—</td>';
          const score = result.score?.total;
          const width = score === undefined ? 0 : Math.round((score / Math.max(maxScore, 1)) * 100);
          const band = score === undefined ? 'muted' : scoreBand(score);
          const mark = result.error ? '✖' : result.test.ran && result.test.failed === 0 && result.test.exitCode === 0 ? '✓' : '✗';
          const tests = testsLabel(result);
          return `<td class="matrix-cell"><div class="cell">
            <span class="score ${band}">${score === undefined ? '—' : score.toFixed(2)}</span>
            <span class="mark ${band}">${mark}</span>
            <span class="tests">${escapeHtml(tests)}</span>
            <span class="bar"><i class="${band}" style="width:${width}%"></i></span>
          </div></td>`;
        })
        .join('');
      return `<tr><th scope="row" class="task">${escapeHtml(taskId)}</th>${cells}</tr>`;
    })
    .join('\n');

  const detailRows = results
    .map((result) => {
      const score = result.score;
      const notes: string[] = [];
      if (result.driverNote) notes.push(result.driverNote);
      if (result.error) notes.push(`error: ${result.error}`);
      if (score && score.regressions.length > 0) notes.push(`regressions: ${score.regressions.join('; ')}`);
      if (result.testFilesTouched.length > 0) notes.push(`edited tests: ${result.testFilesTouched.join(', ')}`);
      if (result.timedOut) notes.push('timeout');
      return `<tr>
        <th scope="row" class="task">${escapeHtml(result.taskId)}</th>
        <td>${escapeHtml(result.driver)}</td>
        <td class="num strong">${score ? score.total.toFixed(2) : '—'}</td>
        <td class="num">${score ? score.solvedRate.toFixed(2) : '—'}</td>
        <td class="num">${score ? score.diff.toFixed(2) : '—'}</td>
        <td class="num">${score ? (score.regressionFree ? 'yes' : 'no') : '—'}</td>
        <td class="num">${escapeHtml(testsLabel(result))}</td>
        <td class="num">${result.baseline?.ran ? `${result.baseline.passed}/${result.baseline.total}` : '—'}</td>
        <td class="num">${result.filesTouched}</td>
        <td class="num">+${result.linesAdded}/−${result.linesRemoved}</td>
        <td class="num">${formatDuration(result.wallClockMs)}</td>
        <td class="num">${result.exitCode === null ? '—' : result.exitCode}</td>
        <td class="notes">${escapeHtml(notes.join(' · '))}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #fbfbf9;
    --surface: #ffffff;
    --ink: #17181a;
    --muted: #6b6f76;
    --line: #e4e3df;
    --good: #1d6f4a;
    --ok: #8a5b00;
    --bad: #a4291f;
    --accent: #1f4fd1;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 1180px; margin: 0 auto; padding: 48px 28px 80px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
  h1 { font-size: 22px; letter-spacing: -0.01em; margin: 0; font-weight: 700; }
  .sub { color: var(--muted); font-size: 13px; }
  .meta { margin-left: auto; color: var(--muted); font-size: 12px; font-family: var(--mono); }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin: 44px 0 10px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
  thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; background: #f6f5f2; }
  tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
  th[scope="row"] { font-weight: 600; }
  .task { font-family: var(--mono); font-size: 12.5px; font-weight: 500; }
  .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 12.5px; }
  .strong { font-weight: 700; }
  .muted, .muted .score { color: var(--muted); }
  .matrix-cell { padding: 7px 10px; min-width: 132px; }
  .cell { display: grid; grid-template-columns: auto auto 1fr; grid-template-rows: auto auto; gap: 0 6px; align-items: baseline; }
  .score { font-family: var(--mono); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; }
  .mark { font-size: 11px; }
  .tests { color: var(--muted); font-family: var(--mono); font-size: 11px; text-align: right; }
  .bar { grid-column: 1 / -1; height: 3px; background: #eeedea; margin-top: 4px; }
  .bar i { display: block; height: 3px; }
  .good { color: var(--good); } .ok { color: var(--ok); } .bad { color: var(--bad); }
  .bar i.good { background: var(--good); } .bar i.ok { background: var(--ok); } .bar i.bad { background: var(--bad); }
  .notes { color: var(--muted); font-size: 12px; max-width: 260px; }
  footer { margin-top: 48px; border-top: 1px solid var(--line); padding-top: 16px; color: var(--muted); font-size: 12px; }
  footer p { margin: 4px 0; }
  .kpi { display: flex; flex-wrap: wrap; gap: 28px; margin-top: 22px; }
  .kpi div { min-width: 120px; }
  .kpi span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .kpi strong { font-family: var(--mono); font-size: 20px; font-weight: 600; }
</style>
</head>
<body>
<main>
  <header>
    <h1>harness-bench</h1>
    <span class="sub">my repo × my harness</span>
    <span class="meta">v${escapeHtml(meta.version)} · ${escapeHtml(meta.generatedAt)}</span>
  </header>

  <section class="kpi">
    <div><span>tasks</span><strong>${meta.tasks}</strong></div>
    <div><span>runs</span><strong>${meta.runs}</strong></div>
    <div><span>drivers</span><strong>${meta.drivers.length}</strong></div>
    <div><span>data</span><strong style="font-size:13px">${escapeHtml(meta.dataDir)}</strong></div>
  </section>

  <h2>Score matrix</h2>
  <table>
    <thead><tr><th>task</th>${matrixHead}</tr></thead>
    <tbody>${matrixRows || `<tr><td colspan="${drivers.length + 1}" class="muted">No runs recorded.</td></tr>`}</tbody>
  </table>

  <h2>Driver summary</h2>
  <table>
    <thead><tr><th>driver</th><th class="num">runs</th><th class="num">mean</th><th class="num">pass@1</th><th class="num">median time</th><th class="num">files</th><th class="num">diff</th><th class="num">errors</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>

  <h2>Runs</h2>
  <table>
    <thead><tr>
      <th>task</th><th>driver</th><th class="num">score</th><th class="num">solved</th><th class="num">diff</th><th class="num">no regress.</th>
      <th class="num">tests run</th><th class="num">baseline</th><th class="num">files</th><th class="num">lines</th><th class="num">time</th><th class="num">exit</th><th>notes</th>
    </tr></thead>
    <tbody>${detailRows || `<tr><td colspan="13" class="muted">No runs recorded.</td></tr>`}</tbody>
  </table>

  <footer>
    <p><strong>Score</strong> = 0.60 · tests solved (the share of tests that fail on the prepared base and pass after the harness runs) + 0.30 · diff similarity (file F1 and changed-line Jaccard against the reference patch) + 0.10 · no regression.</p>
    <p>Each run starts from the commit right before the change, with only the test hunks applied. Test pass rate is measured on the repository's own test command inside an isolated <code>git worktree</code>.</p>
    <p>Small samples are noisy: one run per task×harness says more about variance than about quality. Treat the matrix as a debugging tool for harnesses, not a leaderboard.</p>
  </footer>
</main>
</body>
</html>
`;
}

export function writeHtmlReport(path: string, html: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, 'utf8');
  return path;
}

export function summarizeMeta(
  results: RunResult[],
  options: { dataDir: string; tasks: number; version: string; generatedAt?: string },
): ReportMeta {
  const drivers: string[] = [];
  for (const result of results) if (!drivers.includes(result.driver)) drivers.push(result.driver);
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    dataDir: options.dataDir,
    tasks: options.tasks,
    runs: results.length,
    drivers,
    version: options.version,
  };
}

export function renderJson(results: RunResult[], meta: ReportMeta): string {
  return JSON.stringify(
    {
      meta,
      summary: meta.drivers.map((driver) => {
        const driverRuns = results.filter((result) => result.driver === driver);
        const scored = driverRuns.filter((result) => result.score !== undefined);
        return {
          driver,
          runs: driverRuns.length,
          meanScore: round(mean(scored.map((result) => result.score?.total ?? 0)), 4),
          passAt1: round(mean(driverRuns.map((result) => (result.score?.allTestsPassed ? 1 : 0))), 4),
          medianWallClockMs: Math.round(median(driverRuns.map((result) => result.wallClockMs))),
          errors: driverRuns.filter((result) => result.error).length,
        };
      }),
      results,
    },
    null,
    2,
  );
}
