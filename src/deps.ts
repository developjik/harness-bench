/**
 * A git worktree only contains tracked files, so installed dependencies
 * (`node_modules`, a virtualenv) are missing there. Symlinking them from the
 * source checkout lets the repository's own test command run unchanged.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WELL_KNOWN = ['node_modules', '.venv', 'venv', '.tox'];
const NESTED_PARENTS = ['packages', 'apps', 'services', 'libs', 'workspaces'];

export interface LinkedDependency {
  path: string;
  target: string;
}

export function dependencyCandidates(repo: string): string[] {
  const candidates: string[] = [];
  for (const name of WELL_KNOWN) {
    if (existsSync(join(repo, name))) candidates.push(name);
  }
  for (const parent of NESTED_PARENTS) {
    const parentPath = join(repo, parent);
    if (!existsSync(parentPath)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(parentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      for (const name of ['node_modules', '.venv']) {
        const relative = join(parent, entry, name);
        if (existsSync(join(repo, relative))) candidates.push(relative);
      }
    }
  }
  return candidates;
}

/** Symlinks installed dependencies from `repo` into `worktree`; returns what was linked. */
export function linkWorktreeDependencies(repo: string, worktree: string): LinkedDependency[] {
  const linked: LinkedDependency[] = [];
  for (const relative of dependencyCandidates(repo)) {
    const source = join(repo, relative);
    const target = join(worktree, relative);
    if (existsSync(target)) continue;
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, 'dir');
      linked.push({ path: relative, target: source });
    } catch {
      /* a missing link only means the test command may fail; the run records that */
    }
  }
  return linked;
}
