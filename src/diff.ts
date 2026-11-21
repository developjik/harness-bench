/**
 * Unified-diff parsing: splitting a gold diff into test-only and impl-only
 * patches, and measuring how close a harness patch is to the reference one.
 */

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface PatchFile {
  path: string;
  oldPath: string;
  binary: boolean;
  added: number;
  removed: number;
  hunks: Hunk[];
  rawLines: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function normalizePatchPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === '/dev/null') return '';
  path = path.replace(/^[ab]\//, '');
  return path;
}

export function parsePatch(patch: string): PatchFile[] {
  const lines = patch.split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let currentHunk: Hunk | null = null;

  const pushCurrent = (): void => {
    if (!current) return;
    if (!current.path) current.path = current.oldPath;
    files.push(current);
    current = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushCurrent();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match ? normalizePatchPath(match[2] ?? '') : '';
      current = {
        path,
        oldPath: match ? normalizePatchPath(match[1] ?? '') : path,
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
        rawLines: [line],
      };
      continue;
    }
    if (!current) continue;

    current.rawLines.push(line);

    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = normalizePatchPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = normalizePatchPath(line.slice(4));
      if (path) current.path = path;
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = normalizePatchPath(line.slice(4));
      if (path) current.oldPath = path;
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
      if (line.startsWith('+')) current.added += 1;
      else if (line.startsWith('-')) current.removed += 1;
    }
  }
  pushCurrent();
  return files.filter((file) => file.path.length > 0);
}

export function splitFileBlocks(patch: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

function blockPath(block: string): { path: string; oldPath: string } {
  let path = '';
  let oldPath = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('+++ ')) path = normalizePatchPath(line.slice(4));
    else if (line.startsWith('--- ')) oldPath = normalizePatchPath(line.slice(4));
    else if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match) {
        path = path || normalizePatchPath(match[2] ?? '');
        oldPath = oldPath || normalizePatchPath(match[1] ?? '');
      }
    }
  }
  return { path: path || oldPath, oldPath: oldPath || path };
}

/** Keeps only the file blocks whose (new or old) path is listed. */
export function filterPatch(patch: string, paths: string[]): string {
  const wanted = new Set(paths);
  const kept = splitFileBlocks(patch).filter((block) => {
    const { path, oldPath } = blockPath(block);
    return wanted.has(path) || wanted.has(oldPath);
  });
  if (kept.length === 0) return '';
  return kept.map((block) => (block.endsWith('\n') ? block : `${block}\n`)).join('');
}

/** Removes the last hunk of every file — used by the `partial` mock harness. */
export function dropLastHunkPerFile(patch: string): string {
  const out: string[] = [];
  for (const block of splitFileBlocks(patch)) {
    const lines = block.split('\n');
    const hunkStarts: number[] = [];
    lines.forEach((line, index) => {
      if (HUNK_RE.test(line)) hunkStarts.push(index);
    });
    if (hunkStarts.length <= 1) {
      out.push(block);
      continue;
    }
    const lastStart = hunkStarts[hunkStarts.length - 1] as number;
    const cut = lines.slice(0, lastStart).join('\n');
    out.push(cut.endsWith('\n') ? cut : `${cut}\n`);
  }
  return out.join('');
}

export interface PatchStats {
  files: number;
  hunks: number;
  added: number;
  removed: number;
  paths: string[];
  binaryFiles: number;
}

export function patchStats(patch: string): PatchStats {
  const files = parsePatch(patch);
  return {
    files: files.length,
    hunks: files.reduce((sum, file) => sum + file.hunks.length, 0),
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    paths: files.map((file) => file.path),
    binaryFiles: files.filter((file) => file.binary).length,
  };
}

export function changedLineSets(patch: string): { added: Set<string>; removed: Set<string> } {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.add(normalizeLine(line.slice(1)));
    else if (line.startsWith('-')) removed.add(normalizeLine(line.slice(1)));
  }
  return { added, removed };
}

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Line-level agreement between a harness patch and the gold patch. */
export function lineSimilarity(agentPatch: string, goldPatch: string): number {
  const agent = changedLineSets(agentPatch);
  const gold = changedLineSets(goldPatch);
  const added = jaccard(agent.added, gold.added);
  const removed = jaccard(agent.removed, gold.removed);
  return (added + removed) / 2;
}

export interface FileOverlap {
  recall: number;
  precision: number;
  f1: number;
  matched: string[];
  missed: string[];
  extra: string[];
}

export function fileOverlap(agentFiles: string[], goldFiles: string[]): FileOverlap {
  const agent = new Set(agentFiles);
  const gold = new Set(goldFiles);
  const matched = [...gold].filter((file) => agent.has(file));
  const missed = [...gold].filter((file) => !agent.has(file));
  const extra = [...agent].filter((file) => !gold.has(file));
  const recall = gold.size === 0 ? 1 : matched.length / gold.size;
  const precision = agent.size === 0 ? 0 : matched.length / agent.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { recall, precision, f1, matched, missed, extra };
}
