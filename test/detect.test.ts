import { describe, expect, it } from 'vitest';
import { buildPrompt, classifyFile, bucketFiles, inferTestCommand, isImplFile, isTestFile } from '../src/detect.js';
import { createTempRepo } from './helpers.js';

describe('classifyFile', () => {
  it('recognises the usual test layouts', () => {
    for (const path of [
      'src/math.test.ts',
      'src/math.spec.tsx',
      'test/math.ts',
      'tests/math.py',
      'src/__tests__/button.js',
      'packages/core/test/outputs.test.ts',
      'app/test_models.py',
      'pkg/server_test.go',
      'src/main/java/AppTest.java',
      'spec/models/user_spec.rb',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it('recognises implementation files', () => {
    for (const path of ['src/math.ts', 'packages/core/src/csv.ts', 'cmd/main.go', 'src/lib.rs', 'app/models.py']) {
      expect(isImplFile(path), path).toBe(true);
    }
  });

  it('rejects docs, configs and lockfiles as implementation', () => {
    for (const path of ['README.md', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'src/types.d.ts']) {
      expect(classifyFile(path), path).not.toBe('impl');
    }
  });

  it('buckets mixed changes', () => {
    const buckets = bucketFiles(['src/a.ts', 'src/a.test.ts', 'README.md']);
    expect(buckets.implFiles).toEqual(['src/a.ts']);
    expect(buckets.testFiles).toEqual(['src/a.test.ts']);
    expect(buckets.otherFiles).toEqual(['README.md']);
  });
});

describe('inferTestCommand', () => {
  it('uses the package.json test script with the detected package manager', () => {
    const repo = createTempRepo();
    try {
      repo.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
      expect(inferTestCommand(repo.dir)).toBe('npm test --silent');
      repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      expect(inferTestCommand(repo.dir)).toBe('pnpm test');
      repo.delete('pnpm-lock.yaml');
      repo.write('yarn.lock', '# yarn\n');
      expect(inferTestCommand(repo.dir)).toBe('yarn test');
    } finally {
      repo.cleanup();
    }
  });

  it('falls back to well-known toolchains', () => {
    const repo = createTempRepo();
    try {
      repo.write('pyproject.toml', '[project]\nname = "x"\n');
      expect(inferTestCommand(repo.dir)).toBe('python -m pytest -q');
    } finally {
      repo.cleanup();
    }
    const rust = createTempRepo();
    try {
      rust.write('Cargo.toml', '[package]\nname = "x"\n');
      expect(inferTestCommand(rust.dir)).toBe('cargo test --quiet');
    } finally {
      rust.cleanup();
    }
  });
});

describe('buildPrompt', () => {
  it('carries the commit message, the test files and the command', () => {
    const prompt = buildPrompt('feat: add mul', ['test/math.test.js'], 'npm test');
    expect(prompt).toContain('feat: add mul');
    expect(prompt).toContain('test/math.test.js');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('Do not modify or delete test files');
  });
});
