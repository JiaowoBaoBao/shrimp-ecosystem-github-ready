#!/usr/bin/env node
import crypto from 'node:crypto';
import { ensureDirs, loadConfig, loadState, loadControl, saveState, appendLedger, addEvent, updateLeaderboard, addSemanticMutation, addLineageEvent, ensureAllAgentMemories, appendAgentMemory, blacklistAndArchiveAgent, bootstrapNewAgentMemory, assignExecutionSlots, normalizeSeatGene, clamp } from './lib/runtime.mjs';

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
  addEvent(state, { type: 'CONTROL', level: 'WARN', text: '引擎暂停，evolution_tick 跳过' });
  appendLedger('evolution_ledger', { ts: new Date().toISOString(), type: 'EVOLUTION_SKIPPED', reason: 'engineDisabled' });
  saveState(state);
  console.log('⏸️ evolution_tick skipped: engine disabled');
  process.exit(0);
}

const top = [...state.seats].sort((a, b) => b.score - a.score)[0];
const eliminated = state.seats.filter(s => s.state === 'ELIMINATED');

function buildExecGate(trigger = 'EVOLUTION') {
  const minShadowRounds = Math.max(1, Number(cfg?.execution?.evolution_min_shadow_rounds || 6));
  const requireReplayPass = cfg?.execution?.evolution_require_replay_pass !== false;
  return {
    required: cfg?.execution?.evolution_exec_gate_enabled !== false,
    trigger,
    createdAt: new Date().toISOString(),
    minShadowRounds,
    shadowRounds: 0,
    requireReplayPass,
    replayStatus: 'pending',
    status: 'PENDING',
    reason: 'await-shadow-and-replay'
  };
}

function mutateSeat(from, targetId) {
  const delta = (v, scale = 0.06) => Number((v + (Math.random() - 0.5) * scale).toFixed(2));
  const gene = normalizeSeatGene(from, {
    leverage: from?.position?.leverage || 1,
    regime_bias: from?.regimeFit || 'All',
    prompt_gene_version: 'v4.5-lite'
  });

  const nextGene = {
    ...gene,
    entry_th: clamp(gene.entry_th + (Math.random() - 0.5) * 0.04, 0.01, 2),
    exit_th: clamp(gene.exit_th + (Math.random() - 0.5) * 0.03, 0.005, 2),
    sl: clamp(gene.sl + (Math.random() - 0.5) * 0.004, 0.001, 0.5),
    tp: clamp(gene.tp + (Math.random() - 0.5) * 0.01, 0.001, 1.5),
    turnover: clamp(gene.turnover + (Math.random() - 0.5) * 0.08, 0.01, 5),
    prompt_gene_version: 'v4.5-lite-m1',
    agent_role_id: targetId
  };

  return {
    id: targetId,
    name: `${from.name}-后代`,
    role: from.role,
    state: 'REVIVAL',
    score: delta(from.score, 0.2),
    decisionAlpha24h: delta(from.decisionAlpha24h, 0.08),
    pnl24h: delta(from.pnl24h, 0.5),
    regimeFit: from.regimeFit,
    gene: nextGene,
    prompt_gene_version: nextGene.prompt_gene_version,
    risk_profile: nextGene.risk_profile,
    agent_role_id: nextGene.agent_role_id,
    riskFlags: { hardViolations: 0 },
    executionHealth: { rejectRate: 0, timeoutRate: 0, avgLatencyMs: 0, retryRecoveryRate: 0 },
    execGate: buildExecGate('ELIMINATED_REBIRTH')
  };
}

const replacements = [];
for (const old of eliminated) {
  const eliminationReason = `${old.id} 在 ${old.regimeFit} 条件下表现失效（score=${old.score}）`;
  const archived = blacklistAndArchiveAgent(old.id, eliminationReason, {
    score: old.score,
    state: old.state,
    regimeFit: old.regimeFit,
    decisionAlpha24h: old.decisionAlpha24h,
    pnl24h: old.pnl24h
  });

  const child = mutateSeat(top, old.id);
  const idx = state.seats.findIndex(x => x.id === old.id);
  if (idx >= 0) state.seats[idx] = child;
  replacements.push({ old: old.id, parent: top.id, child: child.id, archivedTo: archived.archivedTo });

  const patchInput = JSON.stringify({
    trigger: 'ELIMINATED',
    old: { id: old.id, score: old.score, da: old.decisionAlpha24h, pnl: old.pnl24h, regimeFit: old.regimeFit },
    parent: { id: top.id, score: top.score },
    ts: new Date().toISOString()
  });
  const beforeHash = crypto.createHash('sha256').update(JSON.stringify(old.gene || {})).digest('hex').slice(0, 16);
  const outputPatch = {
    style: 'more-patient-entry-filter',
    keep_hard_lines: true,
    mutate: ['entry_th', 'exit_th', 'sl', 'tp', 'turnover']
  };
  const afterHash = crypto.createHash('sha256').update(JSON.stringify(child.gene || outputPatch)).digest('hex').slice(0, 16);
  const outputHash = crypto.createHash('sha256').update(JSON.stringify(outputPatch)).digest('hex').slice(0, 16);
  const inputHash = crypto.createHash('sha256').update(patchInput).digest('hex').slice(0, 16);

  const m = addSemanticMutation(state, {
    agentId: old.id,
    parentId: top.id,
    trigger: 'ELIMINATED',
    reason: `${old.id} 在 ${old.regimeFit} 条件下表现失效，重写入场过滤与耐心偏好`,
    modelVersion: 'gpt-5.3-codex',
    inputHash,
    outputHash,
    promptHashBefore: beforeHash,
    promptHashAfter: afterHash,
    status: 'shadow-pass'
  });

  const newMeta = bootstrapNewAgentMemory(child, top.id, `${old.id} 淘汰后补位`);
  appendAgentMemory(child.id, {
    type: 'REBIRTH',
    parentId: top.id,
    generation: newMeta.generation,
    reason: eliminationReason
  });

  addLineageEvent(state, {
    parentId: top.id,
    childId: child.id,
    seatId: old.id,
    trigger: 'ELIMINATED',
    reason: `${old.id} 淘汰后由 ${top.id} 后代补位`
  });

  addLineageEvent(state, {
    parentId: top.id,
    childId: old.id,
    seatId: old.id,
    trigger: 'SEMANTIC_MUTATION',
    reason: m.reason
  });

  addEvent(state, { type: 'BLACKLIST', level: 'WARN', text: `${old.id} 已黑名单并归档：${eliminationReason}` });
  addEvent(state, { type: 'EVOLVE', level: 'INFO', text: `${old.id} 淘汰后由 ${top.id} 变体补位（${child.id}, gen=${newMeta.generation}）` });
  addEvent(state, { type: 'SEMANTIC_MUTATION', level: 'INFO', text: `${m.agentId} 语义突变完成（${m.status}）` });
}

const semanticCandidates = (state.seats || []).filter(s => {
  if (s.state === 'ELIMINATED') return false;
  const warnStreak = Number(state?.hr?.streaks?.[s.id]?.warn || 0);
  const daNegStreak = Number(s?.counterfactual?.decisionAlpha || 0) < 0 && warnStreak >= 2;
  return warnStreak >= 2 || daNegStreak;
});

for (const s of semanticCandidates) {
  const oldGene = normalizeSeatGene(s, { leverage: s?.position?.leverage || 1, regime_bias: s?.regimeFit || 'All' });
  const patch = {
    entry_th: clamp(oldGene.entry_th * 1.06, 0.01, 2),
    exit_th: clamp(oldGene.exit_th * 0.95, 0.005, 2),
    sl: clamp(oldGene.sl * 0.95, 0.001, 0.5),
    tp: clamp(oldGene.tp * 1.04, 0.001, 1.5),
    turnover: clamp(oldGene.turnover * 0.92, 0.01, 5)
  };
  s.gene = { ...oldGene, ...patch, prompt_gene_version: 'v4.5-lite-m2' };
  s.prompt_gene_version = s.gene.prompt_gene_version;
  s.execGate = {
    ...(s.execGate || {}),
    ...buildExecGate('UNDERPERFORM_2EPOCH')
  };

  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ id: s.id, oldGene, score: s.score, da: s.decisionAlpha24h })).digest('hex').slice(0, 16);
  const outputHash = crypto.createHash('sha256').update(JSON.stringify(patch)).digest('hex').slice(0, 16);
  const beforeHash = crypto.createHash('sha256').update(JSON.stringify(oldGene)).digest('hex').slice(0, 16);
  const afterHash = crypto.createHash('sha256').update(JSON.stringify(s.gene)).digest('hex').slice(0, 16);

  const sm = addSemanticMutation(state, {
    agentId: s.id,
    parentId: top.id,
    trigger: 'UNDERPERFORM_2EPOCH',
    reason: `${s.id} 连续弱势，触发语义微调（收紧止损/降低周转）`,
    modelVersion: 'gpt-5.3-codex',
    inputHash,
    outputHash,
    promptHashBefore: beforeHash,
    promptHashAfter: afterHash,
    status: 'shadow-pass'
  });

  addLineageEvent(state, {
    parentId: top.id,
    childId: s.id,
    seatId: s.id,
    trigger: 'SEMANTIC_MUTATION',
    reason: sm.reason
  });
  appendAgentMemory(s.id, { type: 'SEMANTIC_MUTATION', trigger: sm.trigger, promptHashBefore: sm.promptHashBefore, promptHashAfter: sm.promptHashAfter });
}

const revivalShadowEpochs = Math.max(1, Number(cfg?.hr?.revival_shadow_epochs || 1));
for (const s of state.seats) {
  if (s.state === 'REVIVAL') {
    s.revivalEpochs = Number(s.revivalEpochs || 0) + 1;
    if (s.revivalEpochs >= revivalShadowEpochs) {
      s.state = 'ACTIVE';
      s.revivalEpochs = 0;
      appendAgentMemory(s.id, { type: 'REVIVAL_PASS', state: s.state, score: s.score });
      addEvent(state, { type: 'HR', level: 'INFO', text: `${s.id} 复活赛通过，恢复 ACTIVE` });
    } else {
      addEvent(state, { type: 'HR', level: 'INFO', text: `${s.id} 复活赛进行中（${s.revivalEpochs}/${revivalShadowEpochs}）` });
    }
  }
}

updateLeaderboard(state);
const execView = assignExecutionSlots(state, cfg, { force: true });

appendLedger('evolution_ledger', {
  ts: new Date().toISOString(),
  type: 'EVOLUTION_TICK',
  parent: top.id,
  replacements,
  execution: {
    assigned: execView?.assigned || [],
    shadowAgentIds: execView?.shadowAgentIds || []
  }
});

saveState(state);
console.log('✅ evolution_tick done', { parent: top.id, replacements: replacements.length });
