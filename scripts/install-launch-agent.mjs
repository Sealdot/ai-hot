import { spawnSync } from 'node:child_process';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.aihot.local';
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentsDir, `${label}.plist`);
const logsDir = path.join(root, 'data', 'logs');
const nodePath = process.execPath;
const envPath = path.join(root, '.env.local');

function launchctl(...args) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const absentService = /Could not find specified service|No such process|Boot-out failed: 5/i.test(output);
  if (result.status !== 0 && !(args[0] === 'bootout' && absentService)) throw new Error(result.stderr || result.stdout || `launchctl ${args.join(' ')} failed`);
}

if (process.argv.includes('--uninstall')) {
  launchctl('bootout', `gui/${process.getuid()}`, plistPath);
  try { await unlink(plistPath); console.log(`Removed ${plistPath}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.exit(0);
}

const escapeXml = (value) => String(value).replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
let envArgument = '';
try {
  await access(envPath);
  envArgument = `\n    <string>--env-file=${escapeXml(envPath)}</string>`;
} catch { /* Zero-config mode intentionally starts without an env file. */ }
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(nodePath)}</string>${envArgument}
    <string>${escapeXml(path.join(root, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logsDir, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logsDir, 'service.error.log'))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;

if (process.argv.includes('--dry-run')) {
  console.log(plist);
  process.exit(0);
}

await mkdir(agentsDir, { recursive: true });
await mkdir(logsDir, { recursive: true });
await writeFile(plistPath, plist, { encoding: 'utf8', mode: 0o600 });
launchctl('bootout', `gui/${process.getuid()}`, plistPath);
launchctl('bootstrap', `gui/${process.getuid()}`, plistPath);
console.log(`Installed and started ${label}: ${plistPath}`);
