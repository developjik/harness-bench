/** Shared data model for mining, running and scoring. */

export type MockMode = 'oracle' | 'partial' | 'noop';

export interface GoldStats {
  files: number;
  hunks: number;
  added: number;
  removed: number;
}

/** One benchmark case mined from the repository history. */
export interface MinedTask {
  id: string;
  repo: string;
  repoName: string;
  baseCommit: string;
  targetCommit: string;
  authorTime: number;
  commitMessage: string;
  /** Prompt handed to the harness. */
  prompt: string;
  testCommand: string;
  testFiles: string[];
  implFiles: string[];
  otherFiles: string[];
  goldStats: GoldStats;
  /** Full diff base..target (implementation + tests). */
  goldPatch: string;
  /** Only the hunks of test files — applied to the pristine base before the run. */
  testPatch: string;
  /** Only the hunks of implementation files — the reference solution. */
  implPatch: string;
  minedAt: string;
  mineVersion: string;
}

export interface TestSummary {
  command: string;
  ran: boolean;
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
  failedTests: string[];
  countsKnown: boolean;
  /** Counts were parsed, but a failing exit code says they cannot explain the run. */
  countsUncertain?: boolean;
  durationMs: number;
  timedOut?: boolean;
  note?: string;
}

export interface FileScore {
  recall: number;
  precision: number;
  f1: number;
  matched: string[];
  missed: string[];
  extra: string[];
}

export interface ScoreWeights {
  test: number;
  diff: number;
  regression: number;
}

export interface Score {
  total: number;
  test: number;
  /** Share of the tests that were failing on the prepared base and pass now. */
  solvedRate: number;
  diff: number;
  regression: number;
  allTestsPassed: boolean;
  regressionFree: boolean;
  regressions: string[];
  file: FileScore;
  lineSimilarity: number;
  goldHunks: number;
  agentHunks: number;
  weights: ScoreWeights;
}

export interface RunResult {
  id: string;
  taskId: string;
  repoName: string;
  driver: string;
  mockMode?: MockMode;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  patch: string;
  patchFiles: string[];
  filesTouched: number;
  /** Test files the harness modified — a harness that edits tests is suspect. */
  testFilesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  test: TestSummary;
  baseline?: TestSummary;
  score?: Score;
  driverNote?: string;
  commandLine?: string;
  logPath?: string;
  worktreePath?: string;
}

export interface ReportMeta {
  generatedAt: string;
  dataDir: string;
  tasks: number;
  runs: number;
  drivers: string[];
  version: string;
}
