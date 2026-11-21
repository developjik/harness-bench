import { describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependencyCandidates, linkWorktreeDependencies } from '../src/deps.js';
import { createTempDir } from './helpers.js';

describe('linkWorktreeDependencies', () => {
  it('links root and workspace node_modules into a worktree', () => {
    const repo = createTempDir('hb-deps-repo-');
    const worktree = createTempDir('hb-deps-wt-');
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'vitest', 'package.json'), '{"name":"vitest"}');
    mkdirSync(join(repo, 'packages', 'core', 'node_modules'), { recursive: true });

    expect(dependencyCandidates(repo)).toEqual(['node_modules', join('packages', 'core', 'node_modules')]);
    const linked = linkWorktreeDependencies(repo, worktree);
    expect(linked).toHaveLength(2);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(worktree, 'node_modules', 'vitest', 'package.json'), 'utf8')).toContain('vitest');
  });

  it('leaves a worktree that already has node_modules alone', () => {
    const repo = createTempDir('hb-deps-repo-');
    const worktree = createTempDir('hb-deps-wt-');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    expect(linkWorktreeDependencies(repo, worktree)).toEqual([]);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('links nothing when the repo has no installed dependencies', () => {
    const repo = createTempDir('hb-deps-repo-');
    const worktree = createTempDir('hb-deps-wt-');
    expect(linkWorktreeDependencies(repo, worktree)).toEqual([]);
  });
});
