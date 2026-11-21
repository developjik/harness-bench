import { describe, expect, it } from 'vitest';
import {
  dropLastHunkPerFile,
  fileOverlap,
  filterPatch,
  lineSimilarity,
  parsePatch,
  patchStats,
  splitFileBlocks,
} from '../src/diff.js';

const PATCH = `diff --git a/src/math.js b/src/math.js
index 1111111..2222222 100644
--- a/src/math.js
+++ b/src/math.js
@@ -1,2 +1,3 @@
 export const add = (a, b) => a + b;
+export const mul = (a, b) => a * b;
 export const sub = (a, b) => a - b;
diff --git a/test/math.test.js b/test/math.test.js
index 3333333..4444444 100644
--- a/test/math.test.js
+++ b/test/math.test.js
@@ -3,6 +3,10 @@ import { add, mul } from '../src/math.js';
 test('adds', () => {
   assert.equal(add(1, 2), 3);
 });
+
+test('multiplies', () => {
+  assert.equal(mul(2, 2), 4);
+});
`;

const TWO_HUNKS = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,2 +1,3 @@
 export const add = (a, b) => a + b;
+export const mul = (a, b) => a * b;
 export const sub = (a, b) => a - b;
@@ -10,3 +11,4 @@ export const div = (a, b) => a / b;
 export const mod = (a, b) => a % b;
 export const pow = (a, b) => a ** b;
 export const sqrt = (a) => Math.sqrt(a);
+export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
`;

describe('parsePatch', () => {
  it('reads files, hunks and line counts', () => {
    const files = parsePatch(PATCH);
    expect(files.map((file) => file.path)).toEqual(['src/math.js', 'test/math.test.js']);
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[1]?.added).toBe(4);
    expect(files[0]?.added).toBe(1);
    expect(files[0]?.removed).toBe(0);
  });

  it('reports totals through patchStats', () => {
    const stats = patchStats(PATCH);
    expect(stats.files).toBe(2);
    expect(stats.hunks).toBe(2);
    expect(stats.added).toBe(5);
    expect(stats.paths).toEqual(['src/math.js', 'test/math.test.js']);
  });
});

describe('filterPatch', () => {
  it('keeps only the requested files', () => {
    const testOnly = filterPatch(PATCH, ['test/math.test.js']);
    expect(testOnly).toContain('diff --git a/test/math.test.js');
    expect(testOnly).not.toContain('diff --git a/src/math.js');
    expect(parsePatch(testOnly).map((file) => file.path)).toEqual(['test/math.test.js']);
  });

  it('returns an empty string when nothing matches', () => {
    expect(filterPatch(PATCH, ['docs/readme.md'])).toBe('');
  });

  it('splits one block per file', () => {
    expect(splitFileBlocks(PATCH)).toHaveLength(2);
  });
});

describe('dropLastHunkPerFile', () => {
  it('removes the second hunk and keeps the first', () => {
    const reduced = dropLastHunkPerFile(TWO_HUNKS);
    const files = parsePatch(reduced);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks).toHaveLength(1);
    expect(reduced).toContain('mul');
    expect(reduced).not.toContain('clamp');
  });
});

describe('similarity', () => {
  it('scores an identical patch as 1', () => {
    expect(lineSimilarity(PATCH, PATCH)).toBe(1);
  });

  it('scores an unrelated patch near 0', () => {
    const other = `diff --git a/src/other.js b/src/other.js
--- a/src/other.js
+++ b/src/other.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    expect(lineSimilarity(other, PATCH)).toBe(0);
  });

  it('rewards partial overlap', () => {
    const half = filterPatch(PATCH, ['src/math.js']);
    const score = lineSimilarity(half, PATCH);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('computes file recall, precision and F1', () => {
    const overlap = fileOverlap(['src/math.js', 'src/extra.js'], ['src/math.js', 'src/text.js']);
    expect(overlap.recall).toBeCloseTo(0.5);
    expect(overlap.precision).toBeCloseTo(0.5);
    expect(overlap.f1).toBeCloseTo(0.5);
    expect(overlap.missed).toEqual(['src/text.js']);
    expect(overlap.extra).toEqual(['src/extra.js']);
  });
});
