import type { MockMode } from '../types.js';
import { claudeCodeDriver, codexDriver, damonDriver, opencodeDriver } from './cli-harnesses.js';
import { createMockDriver } from './mock.js';
import { MOCK_MODES, type HarnessDriver } from './types.js';

export * from './types.js';
export { createMockDriver } from './mock.js';
export { createCliDriver, whichBinary, shellQuote } from './cli.js';
export { spawnProcess } from './spawn.js';
export { claudeCodeDriver, codexDriver, opencodeDriver, damonDriver } from './cli-harnesses.js';

export const CLI_DRIVERS: HarnessDriver[] = [claudeCodeDriver, codexDriver, opencodeDriver, damonDriver];

const ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  damon: 'damon',
  mock: 'mock',
  dryrun: 'mock',
  'dry-run': 'mock',
};

export const ALL_DRIVER_IDS = ['claude-code', 'codex', 'opencode', 'damon', 'mock'] as const;

export function createDriver(id: string, options: { mockMode?: MockMode; extraArgs?: string[] } = {}): HarnessDriver {
  const canonicalId = ALIASES[id.toLowerCase()];
  if (!canonicalId) {
    throw new Error(`Unknown driver "${id}". Available: ${ALL_DRIVER_IDS.join(', ')}`);
  }
  if (canonicalId === 'mock') return createMockDriver(options.mockMode ?? 'oracle');
  const driver = CLI_DRIVERS.find((candidate) => candidate.id === canonicalId);
  if (!driver) throw new Error(`Driver ${canonicalId} is not registered`);
  return driver;
}

export function createDrivers(
  ids: string[],
  options: { mockMode?: MockMode; extraArgs?: string[] } = {},
): HarnessDriver[] {
  const seen = new Set<string>();
  const drivers: HarnessDriver[] = [];
  for (const id of ids) {
    const driver = createDriver(id, options);
    if (seen.has(driver.id)) continue;
    seen.add(driver.id);
    drivers.push(driver);
  }
  if (drivers.length === 0) drivers.push(createMockDriver(options.mockMode ?? 'oracle'));
  return drivers;
}

export function parseMockMode(raw: string | undefined, fallback: MockMode = 'oracle'): MockMode {
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if ((MOCK_MODES as string[]).includes(value)) return value as MockMode;
  throw new Error(`Unknown --mock-mode "${raw}". Use one of: ${MOCK_MODES.join(', ')}`);
}
