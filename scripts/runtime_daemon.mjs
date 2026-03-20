#!/usr/bin/env node
import { spawn } from 'node:child_process';

const fast = process.argv.includes('--fast');
const roundMs = fast ? 20_000 : 30 * 60_000;
const epochMs = fast ? 90_000 : 24 * 60 * 60_000;
const evolutionMs = fast ? 120_000 : 24 * 60 * 60_000 + 10 * 60_000;
const briefMs = fast ? 60_000 : 24 * 60 * 60_000;
const weeklyMs = fast ? 180_000 : 7 * 24 * 60 * 60_000;
const auditMs = fast ? 75_000 : 6 * 60 * 60_000;

const queue = [];
let busy = false;

function enqueue(task) {
  queue.push({ task, at: Date.now() });
  pump();
}

function pump() {
  if (busy || queue.length === 0) return;
  const item = queue.shift();
  busy = true;

  const p = spawn(process.execPath, ['scripts/run_task.mjs', item.task], {
    cwd: process.cwd(),
    stdio: 'inherit'
  });

  p.on('exit', code => {
    if (code !== 0) console.error(`task ${item.task} exited with ${code}`);
    busy = false;
    pump();
  });
}

console.log('🦐 Shrimp runtime daemon starting...', { fast, roundMs, epochMs, evolutionMs, briefMs, weeklyMs, auditMs, serialized: true });
enqueue('round_tick');
enqueue('copilot_brief');
enqueue('push_payload');
enqueue('send_push');
enqueue('audit_replay');

setInterval(() => enqueue('round_tick'), roundMs);
setInterval(() => enqueue('epoch_close'), epochMs);
setInterval(() => enqueue('evolution_tick'), evolutionMs);
setInterval(() => {
  enqueue('copilot_brief');
  enqueue('push_payload');
  enqueue('send_push');
}, briefMs);
setInterval(() => enqueue('weekly_report'), weeklyMs);
setInterval(() => enqueue('audit_replay'), auditMs);

process.on('SIGINT', () => {
  console.log('\nStopped runtime daemon');
  process.exit(0);
});
