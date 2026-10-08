import { lstat, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectDir, 'data');
const backupsDir = path.join(dataDir, 'backups');
const databasePath = path.join(dataDir, 'ai-news.sqlite');
const input = process.argv[2];
let stagedPath;

try {
  if (!input) throw new Error('Usage: npm run restore -- data/backups/<backup-file> (stop the service first)');
  // Accept a basename or an exact path inside this candidate's backups directory.
  const sourcePath = input === path.basename(input) ? path.join(backupsDir,input) : path.resolve(projectDir,input);
  if (path.dirname(sourcePath) !== backupsDir || !/^ai-news-.*\.sqlite$/.test(path.basename(sourcePath))) {
    throw new Error('Restore source must be an ai-news SQLite file in data/backups/.');
  }
  if ((await lstat(backupsDir)).isSymbolicLink() || !(await lstat(sourcePath)).isFile()) {
    throw new Error('Restore source and backups directory must not be symbolic links.');
  }
  // Validate and stage BEFORE touching the current database or making safety copies.
  const sourceDatabase = new DatabaseSync(sourcePath,{readOnly:true});
  try {
    const integrity = sourceDatabase.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Backup integrity check failed.');
    const tables = new Set(sourceDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    if (!['items','issues','source_state'].every(table=>tables.has(table))) throw new Error('Backup is not an AI HOT database.');
    stagedPath = path.join(dataDir,`.restore-stage-${process.pid}.sqlite`);
    await sqliteBackup(sourceDatabase,stagedPath);
  } finally { sourceDatabase.close(); }
  await mkdir(backupsDir,{recursive:true});
  try {
    if ((await stat(databasePath)).isFile()) {
      const safetyCopy = path.join(backupsDir,`ai-news-pre-restore-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
      const currentDatabase = new DatabaseSync(databasePath,{readOnly:true});
      try { await sqliteBackup(currentDatabase,safetyCopy); } finally { currentDatabase.close(); }
      console.log(`Current database saved to ${safetyCopy}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The service must be stopped: these sidecars belong to the previous database.
  for (const suffix of ['-wal','-shm']) {
    try { await unlink(`${databasePath}${suffix}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rename(stagedPath,databasePath); stagedPath = null;
  console.log(`Restored ${path.basename(sourcePath)} to ${databasePath}`);
  console.log('Start the local service again after this command completes.');
} catch (error) {
  console.error(`Restore failed: ${error.message}`); process.exitCode=1;
} finally {
  if (stagedPath) { try { await unlink(stagedPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
