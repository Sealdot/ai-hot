import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../lib/content.mjs';
import { feedXml } from '../tests/fixtures/local-feed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Explicit whitelist: never copy .env.local, runtime JSON, SQLite, tokens, logs,
// backups, Git metadata or personal config. All processes use this isolated copy.
const files = ['server.mjs','package.json','openapi.yaml','agent/SKILL.md',
  'lib/content.mjs','lib/store.mjs','lib/briefs.mjs','lib/concurrency.mjs',
  'lib/health.mjs','lib/opml.mjs','lib/source-catalog.mjs',
  'public/index.html','public/app.js','public/app.css',
  'scripts/backup.mjs','scripts/restore.mjs','scripts/generate-daily.mjs',
  'tests/content.test.mjs','tests/restore.test.mjs','tests/fixtures/offline-guard.mjs',
  'data/sources.json','data/editorial-overrides.json'];
const demo = process.argv.includes('--demo');
await mkdir(path.join(root, '.alpha-runs'), { recursive: true });
const run = await mkdtemp(path.join(root, '.alpha-runs', 'run-'));
const app = path.join(run, 'app');
await mkdir(app);
for (const file of files) {
  await mkdir(path.dirname(path.join(app, file)), { recursive: true });
  await cp(path.join(root, file), path.join(app, file), { dereference: false, errorOnExist: true });
  assert(!(await lstat(path.join(app, file))).isSymbolicLink());
}
await mkdir(path.join(run, 'tmp'));
const checks = [];
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let server;
let serverOutput = '';
let fixtureHits = 0;
const fixture = createServer((req, res) => {
  fixtureHits++;
  if (req.url === '/feed.xml') {
    if (req.headers['if-none-match'] === '"alpha-v1"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'content-type':'application/rss+xml', etag:'"alpha-v1"' });
    res.end(feedXml(`http://127.0.0.1:${fixture.address().port}`));
  } else if (req.url === '/limited.xml') {
    res.writeHead(429, {'retry-after':'120'}); res.end('Synthetic rate limit');
  } else { res.writeHead(404); res.end('Synthetic missing resource'); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const feedPort = fixture.address().port;
const portReservation = createServer();
await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
const port = portReservation.address().port;
await new Promise(resolve => portReservation.close(resolve));
const env = { PATH:path.dirname(process.execPath), TZ:'UTC', TMPDIR:path.join(run,'tmp'),
  PORT:String(port), ALPHA_ALLOWED_PORTS:`${port},${feedPort}` };
const guard = path.join(app,'tests/fixtures/offline-guard.mjs');
const cli = async (args, expected = 0) => {
  const child = spawn(process.execPath, ['--import',guard,...args], { cwd:app, env, stdio:['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child,'exit');
  assert.equal(code,expected,output); assert(!output.includes('OFFLINE_DENIED'),output);
  return output;
};
const base = `http://127.0.0.1:${port}`;
const api = async (url, method = 'GET', payload, expected = 200, headers = {}) => {
  const response = await fetch(base+url, {method, headers:{'content-type':'application/json',...headers},
    body:payload === undefined ? undefined : JSON.stringify(payload), signal:AbortSignal.timeout(10_000)});
  const body = await response.text(); assert.equal(response.status,expected,`${method} ${url}: ${body}`);
  return body ? JSON.parse(body) : null;
};
const start = async () => {
  server = spawn(process.execPath,['--import',guard,'server.mjs'],{cwd:app,env,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk => { serverOutput += chunk; }); server.stderr.on('data',chunk => { serverOutput += chunk; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { const health = await api('/api/health'); assert.equal(health.enrichment.configured,false); return health; }
    catch { await new Promise(resolve => setTimeout(resolve,50)); }
  }
  throw new Error('Server readiness timed out: '+serverOutput);
};
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  const exited = once(server,'exit'); server.kill('SIGTERM');
  const timer = setTimeout(()=>server.kill('SIGKILL'),7_000);
  const [code] = await exited; clearTimeout(timer); assert.equal(code,0,serverOutput); server = null;
};
try {
  // Environment keys are an allowlist, so no credential or DATABASE_PATH survives.
  assert(!Object.keys(env).some(key => /TOKEN|KEY|MODEL|DATABASE|NODE_OPTIONS/.test(key)));
  const config = JSON.parse(await readFile(path.join(app,'data/sources.json'),'utf8'));
  assert.equal(config.length,138); assert(config.every(source => source.enabled === false));
  assert.deepEqual(JSON.parse(await readFile(path.join(app,'data/editorial-overrides.json'),'utf8')),{});
  // Guard self-test is expected to fail and must never reach external networking.
  const probe = spawn(process.execPath,['--import',guard,'--input-type=module','-e',"fetch('https://outside.invalid/')"],{cwd:app,env,stdio:['ignore','pipe','pipe']});
  let denied=''; probe.stderr.on('data',c=>{denied+=c;});
  const [probeCode] = await once(probe,'exit'); assert.notEqual(probeCode,0); assert.match(denied,/OFFLINE_DENIED/);
  pass('network guard self-test + clean credential environment + 138 disabled catalog entries');
  await writeFile(path.join(run,'unit-tests.txt'),await cli(['--test','tests/content.test.mjs','tests/restore.test.mjs']));
  pass('unit tests under network guard and fixed time');
  const health = await start();
  assert.equal(health.date,'2026-10-08'); assert.equal(health.scheduler.sources,0);
  assert.equal((await api('/api/public/items?mode=all')).items.length,0);
  assert.equal((await api('/api/public/briefs?scope=all')).briefs.length,0);
  const tokenFile = path.join(app,'data/admin-token.runtime');
  assert.equal((await stat(tokenFile)).mode & 0o777,0o600);
  const token = (await readFile(tokenFile,'utf8')).trim();
  const admin = {authorization:`Bearer ${token}`};
  // Scheduler stays ON. Wait through both startup catch-up and maintenance.
  await new Promise(resolve=>setTimeout(resolve,3_300)); assert.equal(fixtureHits,0);
  pass('first boot empty SQLite + local 0600 token + scheduler enabled without external collection');
  for (const route of ['/', '/app.js','/app.css','/openapi.yaml','/.well-known/ai-news-skill.md']) {
    assert.equal((await fetch(base+route)).status,200);
  }
  await api('/api/admin/ingest','POST',{},401);
  await api('/api/reader/brief-state','POST',{id:'unknown',action:'read'},403,{origin:'https://outside.invalid'});
  await api('/api/local/monitors','POST',{name:'blocked'},403,{origin:'https://outside.invalid'});
  pass('Web assets + OpenAPI/Skill + admin authorization + cross-origin writes');
  const imported = await api('/api/local/sources/opml','POST',{opml:`<opml version="2.0"><body><outline text="Invented Alpha" xmlUrl="http://127.0.0.1:${feedPort}/feed.xml"/></body></opml>`},201);
  const sourceId = imported.sources[0].id;
  await api(`/api/local/sources/${sourceId}`,'PATCH',{enabled:false});
  await api(`/api/local/sources/${sourceId}`,'PATCH',{enabled:true});
  const ingestion = await api('/api/admin/ingest','POST',{sourceId},200,admin);
  assert.equal(ingestion.results[0].inserted,3);
  const again = await api(`/api/local/sources/${sourceId}/retry`,'POST',{});
  assert.equal(again.results[0].httpStatus,304);
  const model = await api('/api/admin/enrich','POST',{},200,admin); assert.equal(model.configured,false);
  const all = (await api('/api/public/briefs?scope=all')).briefs;
  assert.equal(all.length,3);
  for (const brief of all) {
    assert.equal(brief.quality.mode,'fallback'); assert.equal(brief.quality.status,'degraded');
    assert.equal(brief.whyItMatters,null);
    assert(brief.summaryClaims.every(claim=>claim.kind === 'fact' && claim.sourceItemIds.every(id=>brief.sources.some(s=>s.itemId===id))));
  }
  assert.equal((await api('/api/health')).scheduler.healthy,1);
  const first = all.find(b=>b.headline.startsWith('Atlas'));
  assert(first);
  assert.equal((await api(`/api/public/briefs/${first.id}`)).brief.reader.readAt,null);
  pass('local OPML -> Feed ingestion -> ETag 304 -> 3 source-traceable fallback briefs');
  for (const action of ['read','save']) {
    const state = await api('/api/reader/brief-state','POST',{id:first.id,action}); assert(state.state[action==='read'?'readAt':'savedAt']);
  }
  await api('/api/reader/brief-state','POST',{id:first.id,action:'note',note:'Invented offline acceptance note'});
  await api('/api/reader/brief-state','POST',{id:first.id,action:'hide'});
  assert(!(await api('/api/public/briefs?scope=all')).briefs.some(b=>b.id===first.id));
  await api('/api/reader/brief-state','POST',{id:first.id,action:'unhide'});
  const itemId = first.sources[0].itemId;
  await api('/api/reader/state','POST',{id:itemId,action:'save'});
  assert.equal((await api('/api/public/briefs/workspace')).summary.saved,1);
  assert.equal((await api('/api/public/briefs/weekly')).summary.read,1);
  pass('explicit read/save/note/hide/unhide + article saved state + workspace + weekly review');
  const monitor = (await api('/api/local/monitors','POST',{id:'alpha-monitor',name:'Atlas Alpha',include:{keywords:['Atlas']},priority:3},201)).monitor;
  assert.equal((await api(`/api/public/briefs/${first.id}`)).brief.ranking.monitorPriority,3);
  await api(`/api/local/monitors/${monitor.id}`,'PATCH',{exclude:{keywords:['reasoning']}});
  assert.equal((await api(`/api/public/briefs/${first.id}`)).brief.ranking.monitorPriority,0);
  await api(`/api/local/monitors/${monitor.id}`,'PATCH',{exclude:{keywords:[]}});
  pass('monitor inclusion/exclusion changes priority');
  const daily = await api('/api/admin/daily','POST',{date:'2026-10-08',force:true},201,admin);
  const selectedCount = all.filter(brief => brief.selected).length;
  assert(selectedCount > 0); assert.equal(daily.issue.briefs.length,selectedCount); assert.equal(daily.issue.quality.status,'degraded');
  for (const route of ['/feeds/briefs.xml','/feeds/all.xml','/feeds/selected.xml','/feeds/daily.xml']) {
    const response = await fetch(base+route); assert.equal(response.status,200);
    assert(parseFeed(await response.text()).length>0,route);
  }
  pass('fixed-date daily issue + all four parseable nonempty RSS endpoints');
  await stop(); await start();
  const persisted = (await api(`/api/public/briefs/${first.id}`)).brief;
  assert.equal(persisted.reader.note,'Invented offline acceptance note'); assert(persisted.reader.readAt && persisted.reader.savedAt);
  assert.equal(persisted.ranking.monitorPriority,3);
  assert.equal((await api('/api/public/reader/workspace')).summary.saved,1);
  assert.equal((await api('/api/public/daily')).issues[0].briefs.length,selectedCount);
  assert.equal((await api('/api/local/monitors')).monitors[0].id,monitor.id);
  pass('restart persists briefs + article/brief reader state + monitors + daily snapshot');
  const backup = await api('/api/local/library/backup','POST',{},201);
  assert(backup.backup.name.endsWith('.sqlite'));
  await api('/api/reader/brief-state','POST',{id:first.id,action:'note',note:'After backup mutation'});
  await api(`/api/local/monitors/${monitor.id}`,'DELETE');
  await stop();
  await writeFile(path.join(run,'restore.txt'),await cli(['scripts/restore.mjs',`data/backups/${backup.backup.name}`]));
  await start();
  const restored = (await api(`/api/public/briefs/${first.id}`)).brief;
  assert.equal(restored.reader.note,'Invented offline acceptance note'); assert(restored.reader.readAt && restored.reader.savedAt);
  assert.equal(restored.ranking.monitorPriority,3);
  assert.equal((await api('/api/public/reader/workspace')).summary.saved,1);
  assert.equal((await api('/api/public/daily')).issues[0].briefs.length,selectedCount);
  assert.equal((await api('/api/local/monitors')).monitors[0].id,monitor.id);
  const lib = await api('/api/local/library'); assert(lib);
  await stop();
  await writeFile(path.join(run,'backup-cli.txt'),await cli(['scripts/backup.mjs']));
  const integrity = await cli(['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('data/ai-news.sqlite',{readOnly:true}); console.log(JSON.stringify(db.prepare('PRAGMA quick_check').all())); db.close();"]);
  assert.match(integrity,/ok/);
  await writeFile(path.join(run,'integrity.txt'),integrity);
  pass('SQLite backup -> mutate -> stop -> CLI restore -> restart recovers notes and monitors + CLI backup');
  assert(!serverOutput.includes('OFFLINE_DENIED'),serverOutput);
  const report = {status:'passed',fixedTime:'2026-10-08T00:06:00.000Z',node:process.version,checks,fixtureHits,
    schedulerEnabled:true,externalNetworkAttempts:0,credentialsInherited:[],sourceFiles:files,
    limitations:['Application process network guard, not OS air-gap','Random UUIDs, ephemeral ports and SQLite bytes are not bit-identical','Source config and admin token are outside SQLite backup']};
  await writeFile(path.join(run,'result.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(path.join(run,'server.txt'),serverOutput.replace(/Generated local admin token at .*/g,'Generated candidate-local admin token (path omitted)'));
  console.log(`Offline Alpha PASSED. Evidence: ${path.relative(root,run)}/result.json`);
  if (demo) {
    await start(); console.log(`Demo ready: ${base}\nAll data: ${path.relative(root,app)}/data\nPress Ctrl+C to stop.`);
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }
} catch (error) {
  await writeFile(path.join(run,'failure.txt'),`${error.stack}\n${serverOutput}`);
  console.error(`Offline Alpha FAILED: ${error.message}\nEvidence: ${path.relative(root,run)}/failure.txt`);
  process.exitCode=1;
} finally {
  await stop(); await new Promise(resolve=>fixture.close(resolve));
}
