/** Turns a run into a score: tests, proximity to the gold patch, and regressions. */

import { fileOverlap, lineSimilarity, patchStats } from './diff.js';
import type { MinedTask, RunResult, Score, ScoreWeights, TestSummary } from './types.js';
import { clamp01, round } from './util.js';

export const DEFAULT_WEIGHTS: ScoreWeights = {
  test: 0.6,
  diff: 0.3,
  regression: 0.1,
};

export interface RegressionAssessment {
  status: 'none' | 'detected' | 'unknown';
  regressions: string[];
  note?: string;
}

/** Compare identities before aggregate counts. Unknown evidence never earns clean credit. */
export function assessRegressions(baseline: TestSummary | undefined, final: TestSummary): RegressionAssessment {
  const unknown = (note: string): RegressionAssessment => ({
    status: 'unknown',
    regressions: [],
    note,
  });
  if (!completedTestRun(final)) return unknown('final test run is incomplete');
  if (final.exitCode === 0 && final.failed === 0) return { status: 'none', regressions: [] };
  if (!baseline || !completedTestRun(baseline)) return unknown('no reliable baseline');
  const a = baseline.failureIdentity,
    b = final.failureIdentity;
  if (
    a &&
    b &&
    baseline.command === final.command &&
    a.runner === b.runner &&
    a.unit === b.unit &&
    a.complete &&
    b.complete &&
    a.ids.length === baseline.failed &&
    b.ids.length === final.failed &&
    baseline.failedTestsComplete !== false &&
    final.failedTestsComplete !== false
  ) {
    const fresh = b.ids.filter((id) => !a.ids.includes(id));
    return { status: fresh.length ? 'detected' : 'none', regressions: fresh };
  }
  if (baseline.countsKnown && final.countsKnown && final.failed > baseline.failed) {
    return {
      status: 'detected',
      regressions: ['(failure count rose above the prepared base)'],
      note: 'aggregate fallback; test identities unavailable',
    };
  }
  return unknown(
    'failure identities are incomplete or use different runners/units; equal or lower counts do not prove no regression',
  );
}

/** Compatibility API: uncertainty is a nonempty marker rather than a clean pass. */
export function detectRegressions(baseline: TestSummary | undefined, final: TestSummary): string[] {
  const result = assessRegressions(baseline, final);
  return result.status === 'unknown' ? [`(regression unknown: ${result.note})`] : result.regressions;
}

/** Parsed partial counts remain diagnostics, never evidence of a completed run. */
function completedTestRun(test: TestSummary): boolean {
  return test.ran && !test.timedOut && test.exitCode !== null && !test.countsUncertain;
}

export interface ScoreInput {
  patch: string;
  patchFiles: string[];
  test: TestSummary;
  baseline?: TestSummary;
  weights?: ScoreWeights;
}

export function scoreRun(task: MinedTask, input: ScoreInput): Score {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const stats = patchStats(input.patch);
  const agentFiles = input.patchFiles.length > 0 ? input.patchFiles : stats.paths;
  const overlap = fileOverlap(agentFiles, task.implFiles);
  const similarity = input.patch.trim().length === 0 ? 0 : lineSimilarity(input.patch, task.implPatch);
  const diffScore = 0.5 * overlap.f1 + 0.5 * similarity;

  // Uncertain counts (failing exit code, zero recorded failures) mean part of
  // the suite produced no summary — scoring the measured pass rate would read
  // an incomplete run as a clean pass.
  const finalComplete = completedTestRun(input.test);
  const testScore = finalComplete ? clamp01(input.test.passRate) : 0;
  // Credit comes from the tests the harness actually fixed: the prepared base
  // already has the new tests failing, so a no-op run must not earn test points
  // for tests that were green before the harness touched anything.
  const solvedRate = !finalComplete
    ? 0
    : input.baseline
      ? completedTestRun(input.baseline)
        ? clamp01((input.test.passed - input.baseline.passed) / Math.max(1, input.baseline.failed))
        : 0
      : testScore;
  const allTestsPassed = finalComplete && input.test.exitCode === 0 && input.test.failed === 0;
  const assessment = assessRegressions(input.baseline, input.test);
  const regressions = assessment.regressions;
  const regressionFree = assessment.status === 'none';
  const regressionScore = regressionFree ? 1 : 0;

  const total = clamp01(weights.test * solvedRate + weights.diff * diffScore + weights.regression * regressionScore);

  return {
    total: round(total, 4),
    test: round(testScore, 4),
    solvedRate: round(solvedRate, 4),
    diff: round(diffScore, 4),
    regression: regressionScore,
    allTestsPassed,
    regressionFree,
    regressionStatus: assessment.status,
    regressionNote: assessment.note,
    regressions,
    file: {
      recall: round(overlap.recall, 4),
      precision: round(overlap.precision, 4),
      f1: round(overlap.f1, 4),
      matched: overlap.matched,
      missed: overlap.missed,
      extra: overlap.extra,
    },
    lineSimilarity: round(similarity, 4),
    goldHunks: patchStats(task.implPatch).hunks,
    agentHunks: stats.hunks,
    weights,
  };
}

export function rescore(results: RunResult[], tasks: MinedTask[], weights?: ScoreWeights): RunResult[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return results.map((result) => {
    const task = byId.get(result.taskId);
    if (!task) return result;
    return {
      ...result,
      score: scoreRun(task, {
        patch: result.patch,
        patchFiles: result.patchFiles,
        test: result.test,
        baseline: result.baseline,
        weights,
      }),
    };
  });
}
