// Isolated cross-project export regressions. Requires a trusted built companion path.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const companion=resolve(process.argv[2]);
const temp=mkdtempSync(join(tmpdir(),'selection-export-test-')), repo=join(temp,'repo');mkdirSync(repo);
const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const exportGraph=(name,ok=true)=>{
 const path=join(temp,name+'.json');
 const r=spawnSync(process.execPath,['scripts/export-selection-graph.mjs',repo,companion,path],{cwd:process.cwd(),encoding:'utf8'});
 if(!ok){assert.equal(r.status,1);assert.match(r.stderr,/offline selection requires a full clone, not a partial\/promisor clone/);return;}
 assert.equal(r.status,0,r.stderr);return JSON.parse(readFileSync(path,'utf8'));
};
try{
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 mkdirSync(join(repo,'config'));mkdirSync(join(repo,'src'));
 writeFileSync(join(repo,'tsconfig.json'),JSON.stringify({extends:'./config/base.json'}));
 writeFileSync(join(repo,'config/base.json'),JSON.stringify({compilerOptions:{baseUrl:'..',paths:{'@/*':['src/*']}}}));
 writeFileSync(join(repo,'src/main.ts'),"import { value } from '@/other'; export const result=value;\n");
 writeFileSync(join(repo,'src/other.ts'),'export const value=1;\n');
 writeFileSync(join(repo,'src/UPPER.TS'),'export const upper=1;\n');
 writeFileSync(join(repo,'README.MD'),'# Uppercase\n');
 if(process.platform!=='win32')writeFileSync(join(repo,'irrelevant?.txt'),'not an index input');
 writeFileSync(join(repo,'unrelated.bin'),Buffer.alloc(17*1024*1024));
 git('add','.');git('commit','-qm','fixture');
 const graph=exportGraph('first');
 assert.ok(graph.files.some(f=>f.path==='src/UPPER.TS'));assert.ok(graph.files.some(f=>f.path==='README.MD'));
 assert.ok(graph.edges.some(e=>e.includes('src/main.ts')&&e.includes('src/other.ts')),'inherited alias must produce a file edge');
 writeFileSync(join(repo,'.git/info/exclude'),'tsconfig.ignored.json\n');
 writeFileSync(join(repo,'tsconfig.ignored.json'),JSON.stringify({compilerOptions:{paths:{'@/*':['missing/*']}}}));
 assert.deepEqual(exportGraph('ignored'),graph);
 git('config','remote.origin.promisor','false');assert.deepEqual(exportGraph('false'),graph);
 git('config','remote.origin.partialclonefilter','blob:none');exportGraph('filter',false);git('config','--unset','remote.origin.partialclonefilter');
 git('config','extensions.partialClone','origin');exportGraph('legacy',false);git('config','--unset','extensions.partialClone');
 console.log('Export regressions passed: uppercase, inherited alias, large binary, ignored config, false/legacy/filter clone flags.');
}finally{rmSync(temp,{recursive:true,force:true});}
