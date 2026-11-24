import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const actual=JSON.parse(readFileSync(process.argv[2],'utf8'));
const expected=JSON.parse(readFileSync(new URL('../examples/graph-selection/experiment.json',import.meta.url),'utf8'));
assert.deepEqual(actual,expected);
console.log('Exact graph selection replay matched, including negative metrics.');
