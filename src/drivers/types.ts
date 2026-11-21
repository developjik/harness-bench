/** The adapter contract every harness implementation follows. */

import type { MinedTask, MockMode } from '../types.js';

export interface DriverContext {
  cwd: string;
  prompt: string;
  task: MinedTask;
  timeoutMs: number;
  dryRun: boolean;
  mockMode: MockMode;
  extraArgs: string[];
  env: NodeJS.ProcessEnv;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface DriverOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallClockMs: number;
  timedOut: boolean;
  note?: string;
  commandLine?: string;
  /** True when no real harness process was started (dry-run or mock). */
  simulated?: boolean;
}

export interface HarnessDriver {
  id: string;
  label: string;
  kind: 'cli' | 'mock';
  /** Human-readable command line, with the prompt abbreviated. */
  commandLine(ctx: Pick<DriverContext, 'prompt' | 'env' | 'extraArgs'>): string;
  available(): Promise<boolean>;
  run(ctx: DriverContext): Promise<DriverOutcome>;
}

export const MOCK_MODES: MockMode[] = ['oracle', 'partial', 'noop'];
