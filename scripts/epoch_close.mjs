#!/usr/bin/env node
import { ensureDirs, loadConfig, loadState, loadControl, saveState, updateLeaderboard, addEvent, appendLedger, ensureAllAgentMemories, appendAgentMemory, summarizeAgentMemory, assignExecutionSlots } from './lib/runtime.mjs';

ensureDirs();
const cfg = loadConfig();
const state = loadState();
if (!state) {
  console.error('state.json not found. Run: node scripts/generate_demo_state.mjs');
  process.exit(1);
}
const control = loadControl();
state.mode = control.mode || state.mode || { shadow_only: true, demo_trade: false };
ensureAllAgentMemories(state);
if (!control.engineEnabled) {
  addEvent(state, { type: 'CONTROL', level: 'WARN', text: '引擎暂停，epoch_close 跳过' });
  appendLedger('evolution_ledger', { ts: new Date().toISOString(), type: 'EPOCH_SKIPPED', reason: 'engineDisabled' });
  saveState(state);
  console.log('⏸️ epoch_close skipped: engine disabled');
  process.exit(0);
}

state.hr = state.hr || { streaks: {}, epoch: 0 };
state.hr.epoch += 1;
const minRoundSamples = Math.max(1, Number(cfg?.hr?.min_round_samples_for_elimination || 12));

const sorted = [...state.seats].sort((a, b) => a.score - b.score);
const warnCount = Math.max(1, Math.ceil(state.seats.length * 0.2));
const warnSet = new Set(sorted.slice(0, warnCount).map(s => s.id));

for (const s of state.seats) {
  const streak = state.hr.streaks[s.id] || { warn: 0, pip: 0 };
  if (warnSet.has(s.id)) {
    streak.warn += 1;
    if (streak.warn >= 2) {
      s.state = 'PIP';
      streak.pip += 1;
      addEvent(state, { type: 'HR', level: 'WARN', text: `${s.id} 进入 PIP（连续 ${streak.warn} 个 epoch 弱势）` });
    } else {
      s.state = 'WARN';
      addEvent(state, { type: 'HR', level: 'WARN', text: `${s.id} 进入 WARN 观察` });
    }
  } else {
    streak.warn = 0;
    streak.pip = 0;
    if (s.state !== 'ELIMINATED') s.state = 'ACTIVE';
  }

  if (s.state === 'PIP' && streak.pip >= 2) {
    const obsRounds = Math.max(0, Number(s.obsRounds || 0));
    if (obsRounds >= minRoundSamples) {
      s.state = 'ELIMINATED';
      addEvent(state, { type: 'HR', level: 'RED', text: `${s.id} PIP 未达标，状态 ELIMINATED` });
    } else {
      s.state = 'PIP';
      addEvent(state, {
        type: 'HR',
        level: 'WARN',
        text: `${s.id} 达到淘汰条件但样本不足（obsRounds=${obsRounds}/${minRoundSamples}），继续保留在 PIP`
      });
    }
  }

  appendAgentMemory(s.id, {
    type: 'EPOCH_REVIEW',
    epoch: state.hr.epoch,
    score: s.score,
    state: s.state,
    obsRounds: s.obsRounds || 0,
    warnStreak: streak.warn,
    pipStreak: streak.pip
  });

  state.hr.streaks[s.id] = streak;
}

updateLeaderboard(state);

const beta = Math.max(0.05, Number(cfg?.execution?.score_beta || 0.45));
const expRows = (state.seats || []).map(s => ({ id: s.id, val: Math.exp(beta * Number(s.score || 0)) }));
const expSum = expRows.reduce((a, b) => a + b.val, 0) || 1;

for (const s of (state.seats || [])) {
  const rawW = (expRows.find(x => x.id === s.id)?.val || 0) / expSum;
  const bounded = Math.max(0.05, Math.min(0.35, rawW));
  s.budgetWeight = Number(bounded.toFixed(4));
}

const weightSum = state.seats.reduce((a, b) => a + Number(b.budgetWeight || 0), 0) || 1;
for (const s of (state.seats || [])) {
  s.budgetWeight = Number((Number(s.budgetWeight || 0) / weightSum).toFixed(4));
}

const execView = assignExecutionSlots(state, cfg, { force: true });

appendLedger('evolution_ledger', {
  ts: new Date().toISOString(),
  type: 'EPOCH_CLOSE',
  epoch: state.hr.epoch,
  seats: state.seats.map(s => ({ id: s.id, state: s.state, score: s.score, budgetWeight: s.budgetWeight, executionMode: s.executionMode })),
  warn: [...warnSet],
  execution: {
    assigned: execView?.assigned || [],
    shadowAgentIds: execView?.shadowAgentIds || []
  }
});

for (const s of state.seats) {
  const r = summarizeAgentMemory(s.id, { keepRecent: 180, summarizeRecent: 40 });
  if (r.summarized) {
    appendLedger('performance_ledger', {
      ts: new Date().toISOString(),
      type: 'MEMORY_SUMMARY',
      agentId: s.id,
      kept: r.kept,
      recent: r.recent
    });
  }
}

saveState(state);
console.log(`✅ epoch_close done (epoch=${state.hr.epoch})`);
