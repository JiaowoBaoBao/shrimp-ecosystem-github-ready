#!/usr/bin/env node
import { ensureDirs, loadConfig, loadState, replayAudit, saveState, appendLedger } from './lib/runtime.mjs';

ensureDirs();
const cfg = loadConfig();
const state = loadState();

if (!state) {
  console.error('state.json not found. Run: node scripts/run_task.mjs seed_state');
  process.exit(1);
}

const replay = replayAudit(state, cfg);
state.audit = state.audit || {};
state.audit.replayStatus = replay.status;
state.audit.missingRows = replay.missingRows;
state.audit.replayIssues = replay.issues;
state.audit.replayLedgers = replay.ledgers;
state.audit.replayCheckedAt = replay.checkedAt;

appendLedger('performance_ledger', {
  ts: new Date().toISOString(),
  type: 'AUDIT_REPLAY',
  status: replay.status,
  missingRows: replay.missingRows,
  issues: replay.issues
});

saveState(state, { cfg, replayAudit: true });
console.log('✅ audit replay done', {
  status: replay.status,
  missingRows: replay.missingRows,
  issues: replay.issues.length
});
