/** Turns a run into a score: tests, proximity to the gold patch, and regressions. */

import { fileOverlap, lineSimilarity, patchStats } from './diff.js';
import type { MinedTask, RunResult, Score, ScoreWeights, TestSummary } from './types.js';
import { clamp01, round } from './util.js';

export const DEFAULT_WEIGHTS: ScoreWeights = { test: 0.6, diff: 0.3, regression: 0.1 };

/**
 * A test that fails now but did not fail on the prepared base is a regression.
 * When names are unavailable the failure counts decide; with no baseline the
 * run is only regression-free when nothing fails at all.
 */
export function detectRegressions(baseline: TestSummary | undefined, final: TestSummary): string[] {
  if (!baseline || !baseline.ran) {
    return final.failed > 0 ? ['(no baseline: failures without a reference point)'] : [];
  }

  // Both sides report counts: the prepared base always has failing tests (the new
  // ones). More failures than the base is the unambiguous regression signal. Names
  // are compared only then, because failure labels (file vs test) may differ
  // between a module error on the base and an assertion error after a run.
  if (baseline.countsKnown && final.countsKnown) {
    if (final.failed <= baseline.failed) return [];
    const newNames = final.failedTests.filter((name) => !baseline.failedTests.includes(name));
    return newNames.length > 0 ? newNames : ['(failure count rose above the prepared base)'];
  }

  const newNames = final.failedTests.filter((name) => !baseline.failedTests.includes(name));
  if (newNames.length > 0) return newNames;
  if (final.passRate < baseline.passRate - 1e-9) {
    return ['(pass rate dropped below the prepared base)'];
  }
  return [];
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

  const testScore = clamp01(input.test.passRate);
  // Credit comes from the tests the harness actually fixed: the prepared base
  // already has the new tests failing, so a no-op run must not earn test points
  // for tests that were green before the harness touched anything.
  const solvedRate =
    input.baseline && input.baseline.ran
      ? clamp01((input.test.passed - input.baseline.passed) / Math.max(1, input.baseline.failed))
      : testScore;
  const allTestsPassed = input.test.ran && input.test.exitCode === 0 && input.test.failed === 0;
  const regressions = detectRegressions(input.baseline, input.test);
  const regressionFree = regressions.length === 0;
  const regressionScore = regressionFree ? 1 : 0;

  const total = clamp01(
    weights.test * solvedRate + weights.diff * diffScore + weights.regression * regressionScore,
  );

  return {
    total: round(total, 4),
    test: round(testScore, 4),
    solvedRate: round(solvedRate, 4),
    diff: round(diffScore, 4),
    regression: regressionScore,
    allTestsPassed,
    regressionFree,
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
