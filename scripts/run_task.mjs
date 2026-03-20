#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const HEALTH_PATH = join(DATA_DIR, 'runtime_health.json');

const task = process.argv[2];
const extraArgs = process.argv.slice(3);

const map = {
  round_tick: 'round_tick.mjs',
  epoch_close: 'epoch_close.mjs',
  evolution_tick: 'evolution_tick.mjs',
  weekly_report: 'weekly_report.mjs',
  copilot_brief: 'build_brief.mjs',
  push_payload: 'push_brief_payload.mjs',
  send_push: 'send_push.mjs',
  send_push_dryrun: 'send_push.mjs',
  log_push_event: 'log_push_event.mjs',
  audit_replay: 'audit_replay.mjs',
  ab_runner: 'ab_runner.mjs',
  seed_state: 'generate_demo_state.mjs',
  check_subaccounts: 'check_subaccount_profiles.mjs',
  export_submission_bundle: 'export_submission_bundle.mjs'
};

function tail(text = '', max = 300) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length <= max ? s : s.slice(-max);
}

function loadHealth() {
  if (!existsSync(HEALTH_PATH)) {
    return {
      version: 1,
      runner: {
        buildHash: 'unknown',
        node: process.version,
        updatedAt: new Date().toISOString()
      },
      tasks: {},
      recent: []
    };
  }
  try {
    return JSON.parse(readFileSync(HEALTH_PATH, 'utf8'));
  } catch {
    return {
      version: 1,
      runner: {
        buildHash: 'unknown',
        node: process.version,
        updatedAt: new Date().toISOString()
      },
      tasks: {},
      recent: []
    };
  }
}

function saveHealth(obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HEALTH_PATH, JSON.stringify(obj, null, 2));
}

function getBuildHash() {
  try {
    const ret = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (ret.status === 0) return String(ret.stdout || '').trim() || 'unknown';
  } catch {}
  return 'unknown';
}

if (!task || !map[task]) {
  console.error('Usage: node scripts/run_task.mjs <seed_state|round_tick|epoch_close|evolution_tick|weekly_report|copilot_brief|push_payload|send_push|send_push_dryrun|log_push_event|audit_replay|ab_runner|check_subaccounts|export_submission_bundle>');
  process.exit(1);
}

const fp = join(__dirname, map[task]);
const scriptArgs = [...extraArgs];
if (task === 'send_push_dryrun' && !scriptArgs.includes('--dry-run')) {
  scriptArgs.push('--dry-run');
}

const startedAt = Date.now();
const buildHash = getBuildHash();

const healthStart = loadHealth();
healthStart.runner = {
  buildHash,
  node: process.version,
  updatedAt: new Date().toISOString()
};
healthStart.tasks = healthStart.tasks || {};
healthStart.tasks[task] = {
  ...(healthStart.tasks[task] || {}),
  running: true,
  lastStartAt: new Date(startedAt).toISOString(),
  lastArgs: scriptArgs,
  lastPid: process.pid,
  buildHash
};
saveHealth(healthStart);

const res = spawnSync(process.execPath, [fp, ...scriptArgs], { encoding: 'utf8' });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);

const endedAt = Date.now();
const code = res.status ?? 1;
const ok = code === 0;
const durationMs = Math.max(0, endedAt - startedAt);

const healthEnd = loadHealth();
healthEnd.runner = {
  buildHash,
  node: process.version,
  updatedAt: new Date().toISOString()
};
healthEnd.tasks = healthEnd.tasks || {};
const prev = healthEnd.tasks[task] || {};
const failStreak = ok ? 0 : Number(prev.failStreak || 0) + 1;
const successStreak = ok ? Number(prev.successStreak || 0) + 1 : 0;
healthEnd.tasks[task] = {
  ...prev,
  running: false,
  buildHash,
  lastStartAt: prev.lastStartAt || new Date(startedAt).toISOString(),
  lastEndAt: new Date(endedAt).toISOString(),
  lastDurationMs: durationMs,
  lastCode: code,
  lastOk: ok,
  lastStdoutTail: tail(res.stdout),
  lastStderrTail: tail(res.stderr),
  failStreak,
  successStreak,
  runCount: Number(prev.runCount || 0) + 1
};
healthEnd.recent = Array.isArray(healthEnd.recent) ? healthEnd.recent : [];
healthEnd.recent.unshift({
  ts: new Date(endedAt).toISOString(),
  task,
  ok,
  code,
  durationMs,
  buildHash
});
healthEnd.recent = healthEnd.recent.slice(0, 120);
saveHealth(healthEnd);

process.exit(code);
