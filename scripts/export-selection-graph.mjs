// Explicitly executes a trusted, built sqlite-graph-mcp checkout supplied by the operator.
// No network, no credentials, no live database opened or modified.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { safeSelectionPath, assertFullSelectionClone } from '../dist/src/selection-safety.js';
const [repoArg, companionArg, outArg] = process.argv.slice(2);
if (!repoArg || !companionArg || !outArg) throw new Error('usage: node scripts/export-selection-graph.mjs <clean-repo> <trusted-built-sqlite-graph-checkout> <new-output.json>');
const repo = resolve(repoArg), companion = resolve(companionArg);
const git = (cwd, ...args) => { const r = spawnSync('git', args, {cwd, encoding:'utf8', timeout:120000, maxBuffer:32*1024*1024, env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'}});if(r.status!==0)throw new Error('git read failed');return r.stdout; };
for (const dir of [repo, companion]) if (git(dir,'status','--porcelain','--untracked-files=normal').trim()) throw new Error('both checkouts must be clean');
assertFullSelectionClone(repo);
assertFullSelectionClone(companion);
const commit = git(repo,'rev-parse','HEAD').trim(), producerCommit=git(companion,'rev-parse','HEAD').trim();
const temp=mkdtempSync(join(tmpdir(),'selection-graph-'));
try {
 const source=join(temp,'source');mkdirSync(source);
 // Index only committed regular blobs, never ignored local files or symlinks.
 for(const row of git(repo,'ls-tree','-rz','--full-tree',commit).split('\0')) {
  const m=/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);if(!m)continue;
  const rel=m[3];
  // Match source/doc/manifest/config inputs, do not read unrelated large binaries.
  if(!/\.(?:[cm]?[jt]sx?|md|mdx|markdown|json)$/i.test(rel))continue;
  if(!safeSelectionPath(rel))throw new Error('unsafe git path');
  const size=Number(git(repo,'cat-file','-s',m[2]).trim());
  if(!Number.isSafeInteger(size)||size<0)throw new Error('invalid blob size');
  if(size>512*1024)continue;
  const content=spawnSync('git',['cat-file','blob',m[2]],{cwd:repo,timeout:30000,maxBuffer:16*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}});
  if(content.status!==0)throw new Error('missing or oversized local blob');
  const destination=join(source,rel);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,content.stdout);
 }
 const {indexWorkspace}=await import(pathToFileURL(join(companion,'dist/src/index.js')).href);
 const path=join(temp,'graph.db');
 await indexWorkspace({root:source,dbPath:path,engine:'heuristic'});
 const db=new Database(path,{readonly:true,fileMustExist:true});
 let nodes, edges;
 try {
 nodes=db.prepare("SELECT id,path FROM nodes WHERE kind='file' AND path IS NOT NULL ORDER BY path").all();
 edges=db.prepare("SELECT a.path AS a,b.path AS b FROM edges e JOIN nodes a ON a.id=e.src JOIN nodes b ON b.id=e.dst WHERE a.path IS NOT NULL AND b.path IS NOT NULL AND a.path<>b.path").all();
 } finally {db.close();}
 const blobs=new Map(git(repo,'ls-tree','-rz','--full-tree',commit).split('\0').flatMap(r=>{const m=/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(r);return m&&m[1]!=='120000'?[[m[3],m[2]]]:[];}));
 const files=nodes.filter(n=>blobs.has(n.path)).map(n=>({path:n.path,blob:blobs.get(n.path)}));
 const paths=new Set(files.map(f=>f.path));
 const pairs=[...new Set(edges.filter(e=>paths.has(e.a)&&paths.has(e.b)).map(e=>JSON.stringify([e.a,e.b].sort())))].sort().map(e=>JSON.parse(e));
 if(git(repo,'rev-parse','HEAD').trim()!==commit||git(companion,'rev-parse','HEAD').trim()!==producerCommit||git(repo,'status','--porcelain').trim()||git(companion,'status','--porcelain').trim())throw new Error('checkout changed during indexing');
 writeFileSync(resolve(outArg),JSON.stringify({version:1,producer:{name:'sqlite-graph-mcp',commit:producerCommit,engine:'heuristic'},commit,files,edges:pairs},null,2)+'\n',{flag:'wx'});
 console.log(resolve(outArg));
} finally {rmSync(temp,{recursive:true,force:true});}
