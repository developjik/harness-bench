import { describe, expect, it } from 'vitest';
import { diffCommits, listCommits, parseCommitLog, repoRoot } from '../src/git.js';
import { buildFixtureRepo } from './helpers.js';

describe('listCommits', () => {
  it('reads commits newest first with their changed files', () => {
    const fixture = buildFixtureRepo();
    try {
      const commits = listCommits(fixture.repo.dir, 10);
      expect(commits).toHaveLength(3);
      expect(commits[0]?.sha).toBe(fixture.targetSha);
      expect(commits[0]?.message).toContain('feat: multiply numbers');
      const paths = commits[0]?.files.map((file) => file.path).sort();
      expect(paths).toEqual(['src/math.js', 'src/text.js', 'test/math.test.js', 'test/text.test.js']);
      expect(commits[2]?.parents).toHaveLength(0);
    } finally {
      fixture.repo.cleanup();
    }
  });

  it('reports the repository root', () => {
    const fixture = buildFixtureRepo();
    try {
      expect(repoRoot(fixture.repo.dir)).toBe(fixture.repo.dir);
    } finally {
      fixture.repo.cleanup();
    }
  });
});

describe('parseCommitLog', () => {
  it('parses a handcrafted log payload', () => {
    const raw =
      '\x1e' +
      'abc1234def\x1fparent1 parent2\x1f1700000000\x1ffeat: something\n\nbody line\x1f' +
      '\0\nM\0src/a.ts\0A\0test/a.test.ts\0R100\0old/name.ts\0src/name.ts\0';
    const commits = parseCommitLog(raw);
    expect(commits).toHaveLength(1);
    const commit = commits[0];
    expect(commit?.sha).toBe('abc1234def');
    expect(commit?.parents).toEqual(['parent1', 'parent2']);
    expect(commit?.authorTime).toBe(1700000000);
    expect(commit?.message).toContain('body line');
    expect(commit?.files).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'test/a.test.ts' },
      { status: 'R100', path: 'src/name.ts' },
    ]);
  });
});

describe('diffCommits', () => {
  it('produces a unified diff restricted to paths', () => {
    const fixture = buildFixtureRepo();
    try {
      const patch = diffCommits(fixture.repo.dir, fixture.baseSha, fixture.targetSha, ['src/math.js']);
      expect(patch).toContain('diff --git a/src/math.js b/src/math.js');
      expect(patch).toContain('+export const mul');
      expect(patch).not.toContain('src/text.js');
    } finally {
      fixture.repo.cleanup();
    }
  });
});
