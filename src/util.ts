/** Small helpers shared across the CLI, miner, runner and report. */

export const VERSION = '0.1.0';
export const MINE_VERSION = '1';
export const DEFAULT_DATA_DIR = '.harness-bench';

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…(${text.length - maxChars} chars truncated)…\n` + text.slice(text.length - maxChars);
}

export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…(${text.length - maxChars} chars truncated)`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, '0')}s`;
}

export function formatPercent(value: number, digits = 0): string {
  return `${(clamp01(value) * 100).toFixed(digits)}%`;
}

/** `owner/repo` → `repo`; a local path → its basename. */
export function repoLabel(repoPath: string): string {
  const cleaned = repoPath.replace(/[/\\]+$/, '');
  const base = cleaned.split(/[/\\]/).pop() ?? cleaned;
  return base.replace(/\.git$/, '') || 'repo';
}

export function padEndVisible(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '').length;
  return text + ' '.repeat(Math.max(0, width - visible));
}

export function padStartVisible(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '').length;
  return ' '.repeat(Math.max(0, width - visible)) + text;
}

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function colorize(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function parseNumberFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function scoreBand(score: number): 'good' | 'ok' | 'bad' {
  if (score >= 0.85) return 'good';
  if (score >= 0.5) return 'ok';
  return 'bad';
}
