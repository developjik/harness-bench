import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { gitOrThrow } from './git.js';
import { safeSelectionPath as safePath } from './selection-safety.js';
import type { MinedTask } from './types.js';

export const SELECTION_VERSION = 'graph-selection-v1';
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface SelectionGraph {
  version: 1;
  producer: { name: 'sqlite-graph-mcp'; commit: string; engine: string };
  commit: string;
  files: Array<{ path: string; blob: string }>;
  edges: Array<[string, string]>;
}
const sha = /^[a-f0-9]{40}$/;


/** Strict transport validation, then bind every graph file to the repository commit. */
export function readSelectionGraph(file: string, repo: string, head: string): SelectionGraph {
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error('graph snapshot exceeds 16 MiB');
  const raw = readFileSync(file);
  if (raw.length > 16 * 1024 * 1024) throw new Error('graph snapshot exceeds 16 MiB');
  const x = JSON.parse(raw.toString('utf8')) as SelectionGraph;
  if (x.version !== 1 || x.producer?.name !== 'sqlite-graph-mcp' || !sha.test(x.producer.commit) || !['heuristic', 'ast'].includes(x.producer.engine) || x.commit !== head || !sha.test(x.commit)) throw new Error('graph schema/producer/HEAD mismatch');
  if (!Array.isArray(x.files) || !x.files.length || x.files.length > 100000 || !Array.isArray(x.edges) || x.edges.length > 200000) throw new Error('graph size/schema invalid');
  const paths = new Set<string>();
  for (const f of x.files) {
    if (!safePath(f.path) || !sha.test(f.blob) || paths.has(f.path)) throw new Error('graph file path/blob invalid or duplicate');
    paths.add(f.path);
  }
  const records = gitOrThrow(repo, ['ls-tree', '-rz', '--full-tree', head]).split('\0');
  const blobs = new Map(records.flatMap(r => {
    const m = /^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(r);
    return m && m[1] !== '120000' ? [[m[3]!, m[2]!] as const] : [];
  }));
  for (const f of x.files) if (blobs.get(f.path) !== f.blob) throw new Error(`graph content mismatch: ${f.path}`);
  const seen = new Set<string>();
  for (const e of x.edges) {
    if (!Array.isArray(e) || e.length !== 2 || !paths.has(e[0]) || !paths.has(e[1]) || e[0] >= e[1] || seen.has(JSON.stringify(e))) throw new Error('graph edge invalid or duplicate');
    seen.add(JSON.stringify(e));
  }
  return x;
}

export function moduleOf(file: string): string { return posix.dirname(file); }
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function metrics(tasks: MinedTask[]) {
  const modules: Record<string, number> = Object.create(null);
  for (const task of tasks) for (const m of new Set(task.implFiles.map(moduleOf))) modules[m] = (modules[m] ?? 0) + 1;
  let sum = 0, pairs = 0;
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = new Set(tasks[i]!.implFiles), b = new Set(tasks[j]!.implFiles);
    sum += [...a].filter(f => b.has(f)).length / new Set([...a, ...b]).size; pairs++;
  }
  return { modules: Object.fromEntries(Object.entries(modules).sort()), moduleCount: Object.keys(modules).length, meanFileJaccard: pairs ? sum / pairs : 0, pairs };
}

/** Offline selection only. Never runs drivers, test commands, or mutates task stores. */
export function compareSelections(tasks: MinedTask[], graph: SelectionGraph, count: number, seed: number) {
  if (!Number.isInteger(count) || count < 1 || count > tasks.length || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('count must fit pool; seed must be uint32');
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || !tasks.length) throw new Error('empty or duplicate candidates');
  const degree = new Map(graph.files.map(f => [f.path, 0]));
  for (const [a, b] of graph.edges) { degree.set(a, degree.get(a)! + 1); degree.set(b, degree.get(b)! + 1); }
  const frequency = new Map<string, number>();
  for (const t of tasks) for (const p of new Set(t.implFiles)) frequency.set(p, (frequency.get(p) ?? 0) + 1);
  const reasons = tasks.map(t => {
    if (!t.implFiles.length || t.implFiles.some(p => !safePath(p))) throw new Error('candidate implementation paths invalid');
    const files = [...new Set(t.implFiles)].sort().map(path => ({ path, degree: degree.get(path) ?? null, candidateChanges: frequency.get(path)! }));
    const signal = files.reduce((s, f) => s + Math.log1p(f.degree ?? 0) + Math.log1p(f.candidateChanges), 0) / files.length;
    return { taskId: t.id, targetCommit: t.targetCommit, baseCommit: t.baseCommit, files, modules: [...new Set(files.map(f => moduleOf(f.path)))].sort(), baseWeight: 1 + signal };
  });
  const chosen: number[] = [], selectedModules = new Map<string, number>(), draws = [];
  const random = seededRandom(seed);
  while (chosen.length < count) {
    const weights = reasons.map((r, i) => chosen.includes(i) ? 0 : r.baseWeight / (1 + Math.max(0, ...r.modules.map(m => selectedModules.get(m) ?? 0))));
    const total = weights.reduce((a, b) => a + b, 0), u = random();
    let threshold = u * total, pick = -1;
    for (let i = 0; i < weights.length; i++) { threshold -= weights[i]!; if (weights[i]! > 0 && threshold < 0) { pick = i; break; } }
    if (pick < 0) pick = weights.findLastIndex(w => w > 0);
    chosen.push(pick);
    draws.push({ taskId: tasks[pick]!.id, random: u, weight: weights[pick]!, totalWeight: total, probability: weights[pick]! / total });
    for (const m of reasons[pick]!.modules) selectedModules.set(m, (selectedModules.get(m) ?? 0) + 1);
  }
  const baseline = tasks.slice(0, count), weighted = chosen.map(i => tasks[i]!);
  const b = metrics(baseline), w = metrics(weighted);
  return {
    version: SELECTION_VERSION, seed, count, candidateCount: tasks.length,
    candidateHash: digest(tasks.map(t => ({ id: t.id, base: t.baseCommit, target: t.targetCommit, files: t.implFiles }))),
    graphHash: digest(graph), graph,
    formula: '(1 + mean(log1p(file degree) + log1p(candidate changes))) / (1 + max(selected count by module))',
    baseline: { method: 'existing newest-first mine order', ids: baseline.map(t => t.id), ...b },
    weighted: { method: 'seeded weighted sampling without replacement, module penalty', ids: weighted.map(t => t.id), ...w, draws },
    reasons,
    delta: { moduleCount: w.moduleCount - b.moduleCount, meanFileJaccard: w.meanFileJaccard - b.meanFileJaccard },
    limitations: [
      'Offline selection experiment only. No harness was run; no quality, performance or cost conclusion follows.',
      'A single HEAD graph is used for historical tasks. Missing or deleted files have unknown degree (null), not proven isolation.',
      'Change frequency counts the fixed mined candidate pool, not all repository history. Modules are POSIX parent directories.',
      'Snapshot producer metadata is provenance, not an authenticity signature. Use the included exporter with trusted code and a clean checkout.',
      'Coverage and file overlap are descriptive proxies, not evidence of task difficulty or representativeness. Zero or negative effects are retained.',
    ],
  };
}
