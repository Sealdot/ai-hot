import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'alpha-restore-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'scripts')); await mkdir(path.join(root,'data/backups'),{recursive:true});
  await copyFile(new URL('../scripts/restore.mjs',import.meta.url),path.join(root,'scripts/restore.mjs'));
  const current = path.join(root,'data/ai-news.sqlite');
  const db = new DatabaseSync(current); db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'keep me\')'); db.close();
  const before = await readFile(current);
  return {root,current,before};
}
async function restore(root,input) {
  const importIndex=process.execArgv.indexOf('--import');
  const preload=importIndex>=0 ? ['--import',process.execArgv[importIndex+1]] : [];
  const child = spawn(process.execPath,[...preload,'scripts/restore.mjs',input],{cwd:root,env:{PATH:path.dirname(process.execPath),TZ:'UTC',ALPHA_ALLOWED_PORTS:process.env.ALPHA_ALLOWED_PORTS||''},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
  const [code] = await once(child,'exit'); return {code,output};
}
test('restore rejects corrupted backup before changing the database',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'data/backups/ai-news-corrupt.sqlite'),'invented invalid sqlite');
  const result=await restore(f.root,'data/backups/ai-news-corrupt.sqlite');
  assert.notEqual(result.code,0,result.output); assert.deepEqual(await readFile(f.current),f.before);
});
test('restore rejects a symlink backup before changing the database',async t=>{
  const f=await fixture(t); const external=path.join(f.root,'outside.sqlite');
  await copyFile(f.current,external); await symlink(external,path.join(f.root,'data/backups/ai-news-link.sqlite'));
  const result=await restore(f.root,'data/backups/ai-news-link.sqlite');
  assert.notEqual(result.code,0,result.output); assert.deepEqual(await readFile(f.current),f.before);
});
test('restore rejects a SQLite file belonging to another application',async t=>{
  const f=await fixture(t); await copyFile(f.current,path.join(f.root,'data/backups/ai-news-foreign.sqlite'));
  const result=await restore(f.root,'data/backups/ai-news-foreign.sqlite');
  assert.notEqual(result.code,0,result.output); assert.deepEqual(await readFile(f.current),f.before);
});
