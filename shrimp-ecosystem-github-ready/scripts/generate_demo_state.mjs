#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { ensureDirs, DATA_DIR, ensureAllAgentMemories, appendAgentMemory, saveJson, BLACKLIST_PATH, loadConfig, assignExecutionSlots, normalizeSeatGene } from './lib/runtime.mjs';

const dataDir = DATA_DIR;
ensureDirs();
const cfg = loadConfig();

const now = new Date();
const ts = now.toISOString();

const seedPos = {
  A1: { instId: 'BTC-USDT', side: 'long', qty: 0.21, entryPx: 96800, leverage: 2 },
  A2: { instId: 'ETH-USDT-SWAP', side: 'short', qty: 3.2, entryPx: 3480, leverage: 2 },
  A3: { instId: 'BTC-USDT', side: 'long', qty: 0.12, entryPx: 96200, leverage: 1 },
  A4: { instId: 'SOL-USDT-SWAP', side: 'short', qty: 95, entryPx: 176, leverage: 2 },
  A5: { instId: 'ETH-USDT', side: 'long', qty: 2.4, entryPx: 3520, leverage: 3 },
  A6: { instId: 'BTC-USDT', side: 'long', qty: 0.08, entryPx: 97000, leverage: 1 }
};

const markPx = { 'BTC-USDT': 97520, 'ETH-USDT': 3460, 'SOL-USDT': 181, 'ETH-USDT-SWAP': 3460, 'SOL-USDT-SWAP': 181 };

const seats = [
  { id: 'A1', name: '虾菲特', role: '价值/收益', state: 'ACTIVE', score: 8.2, decisionAlpha24h: 0.21, pnl24h: 1.4, regimeFit: 'Range' },
  { id: 'A2', name: '虾弗莫尔', role: '趋势', state: 'WARN', score: 6.9, decisionAlpha24h: -0.18, pnl24h: -1.1, regimeFit: 'Trend' },
  { id: 'A3', name: '虾蒙斯', role: '均值', state: 'ACTIVE', score: 8.7, decisionAlpha24h: 0.42, pnl24h: 2.1, regimeFit: 'Range' },
  { id: 'A4', name: '虾尼斯', role: '突破', state: 'PIP', score: 6.5, decisionAlpha24h: 0.09, pnl24h: -0.6, regimeFit: 'Trend' },
  { id: 'A5', name: '虾鲁肯', role: '事件观察', state: 'ACTIVE', score: 7.6, decisionAlpha24h: 0.14, pnl24h: 0.3, regimeFit: 'High-Vol' },
  { id: 'A6', name: '虾里奥', role: '风险防守', state: 'ACTIVE', score: 8.9, decisionAlpha24h: 0.33, pnl24h: 0.0, regimeFit: 'All' }
].map(s => {
  const p = seedPos[s.id];
  const m = markPx[p.instId];
  const ratio = p.side === 'long' ? (m - p.entryPx) / p.entryPx : (p.entryPx - m) / p.entryPx;
  const upl = Number((p.qty * p.entryPx * ratio).toFixed(2));
  const notional = Number((p.qty * m).toFixed(2));
  const marginUsed = Number((notional / p.leverage).toFixed(2));
  const gene = normalizeSeatGene({
    ...s,
    id: s.id,
    regimeFit: s.regimeFit,
    position: p,
    gene: {
      leverage: p.leverage,
      sl: 0.015,
      tp: 0.03,
      regime_bias: s.regimeFit,
      risk_profile: s.id === 'A6' ? 'defensive' : (s.id === 'A4' ? 'aggressive' : 'balanced'),
      agent_role_id: s.id,
      prompt_gene_version: 'v4.5-lite'
    }
  });

  const stopLossPx = p.side === 'long'
    ? Number((p.entryPx * (1 - gene.sl)).toFixed(4))
    : Number((p.entryPx * (1 + gene.sl)).toFixed(4));
  const takeProfitPx = p.side === 'long'
    ? Number((p.entryPx * (1 + gene.tp)).toFixed(4))
    : Number((p.entryPx * (1 - gene.tp)).toFixed(4));

  return {
    ...s,
    gene,
    prompt_gene_version: gene.prompt_gene_version,
    risk_profile: gene.risk_profile,
    agent_role_id: gene.agent_role_id,
    riskFlags: { hardViolations: 0 },
    executionHealth: { rejectRate: 0, timeoutRate: 0, avgLatencyMs: 0, retryRecoveryRate: 0 },
    counterfactual: {
      samples: [],
      window: 0,
      avgExecuted: 0,
      avgNoTrade: 0,
      avgInverse: 0,
      daVsNoTrade: 0,
      daVsInverse: 0,
      decisionAlpha: 0,
      confidence: 0,
      winRate: 0,
      minSamples: 40,
      updatedAt: ts
    },
    scoreBreakdown: { RQ: 5, CF: 5, RC: 6, ES: 7, CP: 10, total: 6.4 },
    budgetWeight: Number((1 / 6).toFixed(4)),
    position: {
      kind: 'shadow',
      ...p,
      markPx: m,
      notional,
      unrealizedPnl: upl,
      stopLossPx,
      takeProfitPx,
      slPct: gene.sl,
      tpPct: gene.tp,
      changePct: Number((ratio * 100).toFixed(2)),
      marginUsed,
      tradeCostUsd: 0,
      tradeCostBps: 0
    }
  };
});

const decisionAlphaSeries = Array.from({ length: 14 }).map((_, i) => {
  const d = new Date(now.getTime() - (13 - i) * 24 * 3600 * 1000);
  const base = 0.05 + Math.sin(i / 3) * 0.1 + (Math.random() - 0.5) * 0.05;
  return { ts: d.toISOString().slice(0, 10), value: Number(base.toFixed(3)) };
});

const accountEquitySeries = Array.from({ length: 14 }).map((_, i) => {
  const d = new Date(now.getTime() - (13 - i) * 24 * 3600 * 1000);
  const base = 100000 + Math.sin(i / 4) * 2200 + i * 140 + (Math.random() - 0.5) * 300;
  return { ts: d.toISOString().slice(0, 10), value: Number(base.toFixed(2)) };
});

const events = [
  { ts, type: 'A6_ALERT', level: 'RED', text: '30分钟触发3次，执行Kill Switch：停新单→撤挂单→reduceOnly' },
  { ts, type: 'HR', level: 'WARN', text: 'A2 连续弱势，进入 WARN 观察名单' },
  { ts, type: 'CF', level: 'INFO', text: 'A4 DecisionAlpha 为正，说明止损优于不交易/反向' }
];

const unrealizedPnl = Number(seats.reduce((a, b) => a + (b.position?.unrealizedPnl || 0), 0).toFixed(2));
const marginUsed = Number(seats.reduce((a, b) => a + (b.position?.marginUsed || 0), 0).toFixed(2));
const equity = 100000;
const available = Number((equity - marginUsed).toFixed(2));

const account = {
  profile: 'demo',
  mode: 'shadow',
  equity,
  available,
  marginUsed,
  unrealizedPnl,
  realizedPnl24h: 238.5,
  pnl24h: Number((unrealizedPnl + 238.5).toFixed(2)),
  updatedAt: ts
};

const payload = {
  generatedAt: ts,
  timezone: 'America/Los_Angeles',
  mode: { shadow_only: true, demo_trade: false },
  regime: 'Range',
  ecosystemDelta: '+3.4',
  account,
  seats,
  leaderboard: {
    top: seats.slice().sort((a, b) => b.score - a.score).slice(0, 3),
    bottom: seats.slice().sort((a, b) => a.score - b.score).slice(0, 2)
  },
  champions: {
    overall: seats.slice().sort((a, b) => b.score - a.score)[0],
    trend: seats.find(s => s.id === 'A2'),
    range: seats.find(s => s.id === 'A3'),
    highVol: seats.find(s => s.id === 'A5')
  },
  semanticMutations: [
    {
      ts,
      id: 'm-demo-001',
      agentId: 'A4',
      parentId: 'A3',
      trigger: 'ELIMINATED',
      reason: '震荡市追突破导致连续止损，重写为更耐心的入场偏好',
      modelVersion: 'gpt-5.3-codex',
      promptHashBefore: '2be1f2...a11',
      promptHashAfter: '77ad99...f08',
      status: 'shadow-pass'
    }
  ],
  lineageHistory: [
    {
      ts: new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
      id: 'l-demo-001',
      parentId: 'A2',
      childId: 'A4',
      seatId: 'A4',
      trigger: 'ELIMINATED',
      reason: '趋势假突破导致淘汰，使用A2衍生补位'
    },
    {
      ts: new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString(),
      id: 'l-demo-002',
      parentId: 'A3',
      childId: 'A4',
      seatId: 'A4',
      trigger: 'SEMANTIC_MUTATION',
      reason: '语义突变：增加假突破过滤'
    }
  ],
  risk: {
    a6Trigger30m: 3,
    level: 'RED',
    drawdownDayPct: 1.7,
    drawdownWeekPct: 3.8,
    action: '建议降低仓位到20%以下并暂停新开仓'
  },
  metrics: {
    decisionAlphaSeries,
    scoreSeries: accountEquitySeries.map((x, i) => ({ ts: x.ts, value: Number((7.2 + Math.sin(i / 4) * 0.6).toFixed(2)) })),
    counterfactualSeries: decisionAlphaSeries.map(x => ({ ts: x.ts, value: Number((x.value / 8).toFixed(6)), confidence: 0.55 })),
    counterfactualSummary: {
      avgDecisionAlpha: 0,
      avgConfidence: 0,
      minSamples: 40,
      window: 120,
      updatedAt: ts
    },
    accountEquitySeries,
    executionCostSeries: [],
    abTest: {
      baseline: { decisionAlpha: 0.07, maxDrawdown: 8.9, halts: 5 },
      variant: { decisionAlpha: 0.16, maxDrawdown: 6.7, halts: 3 }
    },
    abExperiment: {
      lookbackDays: 21,
      baselineWindowDays: 7,
      variantWindowDays: 7,
      updatedAt: ts,
      baseline: { decisionAlphaAvg: 0.07, maxDrawdownPct: 8.9, halts: 5 },
      variant: { decisionAlphaAvg: 0.16, maxDrawdownPct: 6.7, halts: 3 },
      gates: { decisionAlphaBetter: true, drawdownDropPct: 24.7, haltsDropPct: 40 }
    }
  },
  events,
  audit: {
    dailyRootHash: crypto.createHash('sha256').update(ts + JSON.stringify(seats)).digest('hex'),
    replayStatus: 'PASS',
    missingRows: 0
  }
};

assignExecutionSlots(payload, cfg, { force: true });

writeFileSync(join(dataDir, 'state.json'), JSON.stringify(payload, null, 2));
writeFileSync(join(dataDir, 'control.json'), JSON.stringify({
  engineEnabled: true,
  mode: { shadow_only: true, demo_trade: false },
  okxProfile: 'demo',
  writeArmed: false,
  writeArmUntil: null,
  updatedAt: new Date().toISOString()
}, null, 2));

ensureAllAgentMemories(payload);
for (const s of seats) {
  appendAgentMemory(s.id, {
    type: 'INIT',
    score: s.score,
    state: s.state,
    reason: 'seed_state 初始化'
  });
}
saveJson(BLACKLIST_PATH, { items: [] });

console.log('✅ state.json generated:', join(dataDir, 'state.json'));
console.log('✅ control.json generated:', join(dataDir, 'control.json'));
console.log('✅ per-agent memory initialized:', join(dataDir, 'agents'));
