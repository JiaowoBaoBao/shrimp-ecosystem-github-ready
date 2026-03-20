#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { loadConfig } from './lib/runtime.mjs';

const cfg = loadConfig();
const csv = cfg?.execution?.account_profiles || cfg?.execution?.accountProfiles || '';
const profiles = String(csv).split(',').map(s => s.trim()).filter(Boolean);

if (!profiles.length) {
  console.error('No execution.account_profiles configured in config/shrimp.config.yaml');
  process.exit(1);
}

function run(cmd, args = []) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status ?? 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

console.log(`Checking ${profiles.length} profiles from execution.account_profiles ...\n`);

let pass = 0;
for (const p of profiles) {
  const r = run('okx', ['--profile', p, 'account', 'balance', '--json']);
  if (r.ok) {
    pass += 1;
    console.log(`✅ ${p}`);
  } else {
    const msg = (r.stderr || r.stdout || '').split('\n')[0].slice(0, 140);
    console.log(`❌ ${p}  (${msg || 'unknown error'})`);
  }
}

console.log(`\nResult: ${pass}/${profiles.length} profile(s) ready.`);
if (pass !== profiles.length) {
  console.log('Hint: run `okx config init` to add/fix missing profiles, then re-run this checker.');
  process.exit(2);
}
