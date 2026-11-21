import { describe, expect, it } from 'vitest';
import { mineTasks } from '../src/miner.js';
import { parsePatch } from '../src/diff.js';
import { repoLabel } from '../src/util.js';
import { buildFixtureRepo } from './helpers.js';

describe('mineTasks', () => {
  it('mines a commit that changes implementation and tests together', () => {
    const fixture = buildFixtureRepo();
    try {
      const report = mineTasks({ repo: fixture.repo.dir, maxTasks: 10, limit: 20 });
      expect(report.tasks).toHaveLength(1);
      const task = report.tasks[0];
      expect(task?.id).toBe(`${repoLabel(fixture.repo.dir)}-${fixture.targetSha.slice(0, 8)}`);
      expect(task?.baseCommit).toBe(fixture.baseSha);
      expect(task?.targetCommit).toBe(fixture.targetSha);
      expect(task?.repoName).toBe(repoLabel(fixture.repo.dir));
      expect(task?.testCommand).toBe('npm test --silent');
      expect(task?.implFiles.sort()).toEqual(['src/math.js', 'src/text.js']);
      expect(task?.testFiles.sort()).toEqual(['test/math.test.js', 'test/text.test.js']);
      expect(task?.commitMessage).toContain('feat: multiply numbers');
      expect(task?.prompt).toContain('npm test --silent');
    } finally {
      fixture.repo.cleanup();
    }
  });

  it('splits the gold diff into test-only and impl-only patches', () => {
    const fixture = buildFixtureRepo();
    try {
      const task = mineTasks({ repo: fixture.repo.dir, maxTasks: 10 }).tasks[0];
      expect(task).toBeDefined();
      if (!task) return;
      const testPaths = parsePatch(task.testPatch).map((file) => file.path).sort();
      const implPaths = parsePatch(task.implPatch).map((file) => file.path).sort();
      expect(testPaths).toEqual(['test/math.test.js', 'test/text.test.js']);
      expect(implPaths).toEqual(['src/math.js', 'src/text.js']);
      expect(task.goldStats.files).toBe(4);
      expect(task.goldPatch).toContain('+export const mul');
    } finally {
      fixture.repo.cleanup();
    }
  });

  it('skips docs-only commits and reports why', () => {
    const fixture = buildFixtureRepo();
    try {
      const report = mineTasks({ repo: fixture.repo.dir, maxTasks: 10 });
      const reasons = report.skipped.map((record) => record.reason).join('\n');
      expect(reasons).toContain('no test files changed');
      expect(reasons).toContain('root commit');
    } finally {
      fixture.repo.cleanup();
    }
  });

  it('honours --since', () => {
    const fixture = buildFixtureRepo();
    try {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const report = mineTasks({ repo: fixture.repo.dir, since: future });
      expect(report.tasks).toHaveLength(0);
    } finally {
      fixture.repo.cleanup();
    }
  });

  it('needs a test command when the repository has none', () => {
    const fixture = buildFixtureRepo();
    try {
      fixture.repo.write('package.json', JSON.stringify({ name: 'no-tests' }));
      fixture.repo.commit('chore: drop the test script');
      expect(() => mineTasks({ repo: fixture.repo.dir })).toThrow(/--test-cmd/);
      const report = mineTasks({ repo: fixture.repo.dir, testCommand: 'node --test' });
      expect(report.testCommand).toBe('node --test');
    } finally {
      fixture.repo.cleanup();
    }
  });
});
