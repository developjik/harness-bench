/** Persistence for mined tasks: SQLite (default) or a plain JSONL file. */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { MinedTask, RunResult } from './types.js';
import { nowIso } from './util.js';

export type StoreKind = 'sqlite' | 'jsonl';

export interface SaveSummary {
  inserted: number;
  updated: number;
  total: number;
}

export interface TaskStore {
  readonly kind: StoreKind;
  readonly path: string;
  save(tasks: MinedTask[]): SaveSummary;
  list(): MinedTask[];
  get(id: string): MinedTask | undefined;
  close(): void;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function taskStorePath(dataDir: string, kind: StoreKind): string {
  return join(dataDir, kind === 'sqlite' ? 'tasks.db' : 'tasks.jsonl');
}

export function resultsPath(dataDir: string): string {
  return join(dataDir, 'results.jsonl');
}

class JsonlStore implements TaskStore {
  readonly kind = 'jsonl' as const;
  readonly path: string;
  private tasks = new Map<string, MinedTask>();

  constructor(dataDir: string) {
    ensureDir(dataDir);
    this.path = taskStorePath(dataDir, 'jsonl');
    this.tasks = readJsonl<TaskRow>(this.path).reduce((map, row) => {
      if (row && row.id && row.payload) map.set(row.id, row.payload);
      return map;
    }, new Map<string, MinedTask>());
  }

  save(tasks: MinedTask[]): SaveSummary {
    let inserted = 0;
    let updated = 0;
    for (const task of tasks) {
      if (this.tasks.has(task.id)) updated += 1;
      else inserted += 1;
      this.tasks.set(task.id, task);
    }
    const rows: TaskRow[] = [...this.tasks.values()].map((task) => ({
      id: task.id,
      repoName: task.repoName,
      targetCommit: task.targetCommit,
      minedAt: task.minedAt,
      payload: task,
    }));
    writeFileAtomic(this.path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    return { inserted, updated, total: this.tasks.size };
  }

  list(): MinedTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): MinedTask | undefined {
    return this.tasks.get(id);
  }

  close(): void {
    /* nothing to close */
  }
}

interface TaskRow {
  id: string;
  repoName: string;
  targetCommit: string;
  minedAt: string;
  payload: MinedTask;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

class SqliteStore implements TaskStore {
  readonly kind = 'sqlite' as const;
  readonly path: string;
  private db: SqliteDatabase;

  constructor(dataDir: string) {
    ensureDir(dataDir);
    this.path = taskStorePath(dataDir, 'sqlite');
    let factory: unknown;
    try {
      const require = createRequire(import.meta.url);
      factory = require('better-sqlite3');
    } catch (error) {
      throw new Error(
        `better-sqlite3 is not available (${(error as Error).message}). Install it, or use --store jsonl.`,
      );
    }
    const Database = (factory as { default?: unknown }).default ?? factory;
    this.db = new (Database as new (path: string) => SqliteDatabase)(this.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        repo_name TEXT NOT NULL,
        target_commit TEXT NOT NULL,
        mined_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_repo ON tasks(repo_name);
    `);
  }

  save(tasks: MinedTask[]): SaveSummary {
    const statement = this.db.prepare(`
      INSERT INTO tasks (id, repo_name, target_commit, mined_at, payload)
      VALUES (@id, @repo_name, @target_commit, @mined_at, @payload)
      ON CONFLICT(id) DO UPDATE SET
        repo_name = excluded.repo_name,
        target_commit = excluded.target_commit,
        mined_at = excluded.mined_at,
        payload = excluded.payload
    `);
    let inserted = 0;
    let updated = 0;
    const existing = new Set(this.list().map((task) => task.id));
    const transaction = (this.db as unknown as { transaction(fn: () => void): () => void }).transaction;
    const run = (): void => {
      for (const task of tasks) {
        if (existing.has(task.id)) updated += 1;
        else inserted += 1;
        statement.run({
          id: task.id,
          repo_name: task.repoName,
          target_commit: task.targetCommit,
          mined_at: task.minedAt,
          payload: JSON.stringify(task),
        });
      }
    };
    if (typeof transaction === 'function') transaction.call(this.db, run)();
    else run();
    return { inserted, updated, total: this.list().length };
  }

  list(): MinedTask[] {
    const rows = this.db.prepare('SELECT payload FROM tasks ORDER BY mined_at DESC').all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as MinedTask);
  }

  get(id: string): MinedTask | undefined {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as MinedTask) : undefined;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export function openTaskStore(kind: StoreKind, dataDir: string): TaskStore {
  return kind === 'jsonl' ? new JsonlStore(dataDir) : new SqliteStore(dataDir);
}

export function detectStoreKind(dataDir: string): StoreKind {
  if (existsSync(taskStorePath(dataDir, 'sqlite'))) return 'sqlite';
  if (existsSync(taskStorePath(dataDir, 'jsonl'))) return 'jsonl';
  return 'sqlite';
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupted line, keep the rest usable */
    }
  }
  return rows;
}

export function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}

/** Results are append-replace by run id: a rerun of the same task×driver overwrites. */
export function saveResults(dataDir: string, results: RunResult[]): number {
  ensureDir(dataDir);
  const path = resultsPath(dataDir);
  const existing = readJsonl<RunResult>(path);
  const map = new Map(existing.map((result) => [result.id, result]));
  for (const result of results) map.set(result.id, result);
  writeFileAtomic(path, [...map.values()].map((result) => JSON.stringify(result)).join('\n') + '\n');
  return map.size;
}

export function loadResults(dataDir: string): RunResult[] {
  return readJsonl<RunResult>(resultsPath(dataDir));
}

export function timestampSlug(): string {
  return nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}
