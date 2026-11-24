import { describe, expect, it } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareSelections, readSelectionGraph, digest, seededRandom, type SelectionGraph } from '../src/selection.js';
import { main } from '../src/cli.js';
import { buildFixtureRepo, createTempDir } from './helpers.js';
import { mineTasks } from '../src/miner.js';
import { safeSelectionPath, assertFullSelectionClone } from '../src/selection-safety.js';
import { gitOrThrow } from '../src/git.js';
import type { MinedTask } from '../src/types.js';
const graph: SelectionGraph={version:1,producer:{name:'sqlite-graph-mcp',commit:'a'.repeat(40),engine:'heuristic'},commit:'b'.repeat(40),files:[{path:'src/a.ts',blob:'c'.repeat(40)},{path:'lib/b.ts',blob:'d'.repeat(40)}],edges:[['lib/b.ts','src/a.ts']]};
const tasks=Array.from({length:8},(_,i)=>({id:`t${i}`,baseCommit:`base${i}`,targetCommit:`target${i}`,implFiles:[i<5?'src/a.ts':`lib${i}/b.ts`],goldPatch:`gold${i}`} as MinedTask));
describe('offline selection',()=>{
 it('replays exact reports and hashes with fixed inputs and seed',()=>{
  const a=compareSelections(tasks,graph,4,42),b=compareSelections(tasks,graph,4,42);
  expect(a).toEqual(b);expect(a.baseline.ids).toEqual(['t0','t1','t2','t3']);
  expect(new Set(a.weighted.ids).size).toBe(4);expect(a.reasons).toHaveLength(8);expect(a.graph).toEqual(graph);
  for(const draw of a.weighted.draws){expect(draw.probability).toBeGreaterThan(0);expect(draw.probability).toBeLessThanOrEqual(1);}
  expect(a.reasons[5]!.files[0]!.degree).toBeNull();
 });
 it('seed changes sampling, never candidate pool, baseline, or count',()=>{
  const a=compareSelections(tasks,graph,4,0),b=compareSelections(tasks,graph,4,45);
  expect(a.weighted.ids).not.toEqual(b.weighted.ids);expect(a.candidateHash).toBe(b.candidateHash);expect(compareSelections(tasks.map(t=>({...t,goldPatch:t.goldPatch+'abbreviated display'})),graph,4,0).candidateHash).toBe(a.candidateHash);expect(a.baseline).toEqual(b.baseline);
 });
 it('preserves no-effect and worse-effect metrics rather than declaring a win',()=>{
  const a=compareSelections(tasks.slice(0,4),graph,4,1);
  expect(a.delta).toEqual({moduleCount:0,meanFileJaccard:0});
  const diverse=tasks.slice(5).concat(tasks.slice(0,5));
  const runs=Array.from({length:100},(_,s)=>compareSelections(diverse,graph,3,s));
  expect(runs.some(r=>r.delta.moduleCount<0)).toBe(true);
 });
 it('rejects invalid counts, seeds, paths and duplicate IDs',()=>{
  for(const n of [0,1.5,9,NaN])expect(()=>compareSelections(tasks,graph,n,1)).toThrow();
  for(const s of [-1,2**32,1.2])expect(()=>compareSelections(tasks,graph,2,s)).toThrow();
  expect(()=>compareSelections([tasks[0]!,tasks[0]!],graph,1,1)).toThrow();
  expect(()=>compareSelections([{...tasks[0]!,implFiles:['../secret']}],graph,1,1)).toThrow();
 });
 it('exposes deterministic random stream and content-sensitive hashes',()=>{
  const a=seededRandom(7),b=seededRandom(7);expect([a(),a()]).toEqual([b(),b()]);expect(digest(graph)).not.toBe(digest({...graph,edges:[]}));
 });
});
describe('graph binding and CLI',()=>{
 it('validates HEAD, blobs, duplicate and traversal paths, edge endpoints and producer',()=>{
  const fixture=buildFixtureRepo(),dir=createTempDir('selection-test-');
  try {
   const blob=gitOrThrow(fixture.repo.dir,['rev-parse',`${fixture.targetSha}:src/math.js`]).trim();
   const good:SelectionGraph={...graph,commit:fixture.targetSha,files:[{path:'src/math.js',blob}],edges:[]};
   const file=join(dir,'graph.json');
   const read=(x:unknown)=>{writeFileSync(file,JSON.stringify(x));return readSelectionGraph(file,fixture.repo.dir,fixture.targetSha);};
   expect(read(good)).toEqual(good);
   for(const bad of [{...good,commit:'0'.repeat(40)},{...good,files:[{path:'../secret',blob}]},{...good,files:[...good.files,...good.files]},{...good,files:[{path:'src/math.js',blob:'0'.repeat(40)}]},{...good,edges:[['src/math.js','missing']]},{...good,producer:{...good.producer,name:'other'}}])expect(()=>read(bad)).toThrow();
   const io={out:()=>{},err:()=>{}};
   writeFileSync(file,JSON.stringify(good));
   return main(['select','--repo',fixture.repo.dir,'--graph-snapshot',file,'--count','1','--seed','0','--test-cmd',`node -e "require('fs').writeFileSync('${join(dir,'MUST-NOT-EXIST')}','ran')"`,'--out',join(dir,'report.json')],io).then(code=>{
    expect(code).toBe(0);expect(existsSync(join(dir,'MUST-NOT-EXIST'))).toBe(false);expect(mineTasks({repo:fixture.repo.dir}).tasks).toHaveLength(1);
    return main(['select','--repo',fixture.repo.dir,'--graph-snapshot',file,'--count','1','--out',file],io);
   }).then(code=>expect(code).toBe(1)).finally(()=>{fixture.repo.cleanup();rmSync(dir,{recursive:true,force:true});});
  } catch(e){fixture.repo.cleanup();rmSync(dir,{recursive:true,force:true});throw e;}
 });
 it('fails closed on missing graph or dirty checkout and does not run a supplied test command',async()=>{
  const f=buildFixtureRepo(),out:string[]=[],err:string[]=[];const io={out:(s:string)=>out.push(s),err:(s:string)=>err.push(s)};
  try{
   expect(await main(['select','--repo',f.repo.dir],io)).toBe(2);
   f.repo.write('untracked.txt','dirty');
   expect(await main(['select','--repo',f.repo.dir,'--graph-snapshot','missing','--test-cmd','exit 99'],io)).toBe(2);
   expect(err.join('')).toContain('clean checkout');
  }finally{f.repo.cleanup();}
 });
});

it('rejects partial clones before historical object reads',async()=>{
 const f=buildFixtureRepo();try{gitOrThrow(f.repo.dir,['config','remote.origin.promisor','true']);const err:string[]=[];expect(await main(['select','--repo',f.repo.dir,'--graph-snapshot','missing'],{out:()=>{},err:s=>err.push(s)})).toBe(2);expect(err.join('')).toContain('full clone');}finally{f.repo.cleanup();}
});

it('portable paths reject Windows traversal, drive, stream and device forms',()=>{
 for(const p of ['..\\escape','folder/..\\escape','C:/outside','file:stream','folder/NUL.txt','folder/x.','folder/x ','docs/a?.md','docs/COM¹.txt','docs/x*.md','docs/a|b.md'])expect(safeSelectionPath(p)).toBe(false);
 expect(safeSelectionPath('src/valid.ts')).toBe(true);
});
it('accepts explicit false promisor and rejects legacy partial clone',()=>{
 const f=buildFixtureRepo();try{gitOrThrow(f.repo.dir,['config','remote.origin.promisor','false']);expect(()=>assertFullSelectionClone(f.repo.dir)).not.toThrow();gitOrThrow(f.repo.dir,['config','extensions.partialClone','origin']);expect(()=>assertFullSelectionClone(f.repo.dir)).toThrow(/full clone/);}finally{f.repo.cleanup();}
});

it('rejects a leftover partialclonefilter even when promisor is false',()=>{
 const f=buildFixtureRepo();try{gitOrThrow(f.repo.dir,['config','remote.origin.promisor','false']);gitOrThrow(f.repo.dir,['config','remote.origin.partialclonefilter','blob:none']);expect(()=>assertFullSelectionClone(f.repo.dir)).toThrow(/full clone/);}finally{f.repo.cleanup();}
});
