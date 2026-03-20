#!/usr/bin/env node
import { ensureDirs, loadState, saveState, addEvent, appendLedger } from './lib/runtime.mjs';

ensureDirs();
const state = loadState();
if (!state) {
  console.error('state.json not found. Run: node scripts/run_task.mjs seed_state');
  process.exit(1);
}

const status = (process.argv[2] || '').toLowerCase(); // success | fail
const detail = process.argv.slice(3).join(' ') || '';
if (!status || !['success', 'fail'].includes(status)) {
  console.error('Usage: node scripts/log_push_event.mjs <success|fail> [detail...]');
  process.exit(1);
}

const level = status === 'success' ? 'INFO' : 'RED';
const text = status === 'success'
  ? `Telegram 推送成功${detail ? `（${detail}）` : ''}`
  : `Telegram 推送失败${detail ? `（${detail}）` : ''}`;

addEvent(state, { type: 'PUSH', level, text });
appendLedger('performance_ledger', {
  ts: new Date().toISOString(),
  type: 'PUSH',
  status,
  detail
});

saveState(state);
console.log(`✅ push event logged: ${status}`);
