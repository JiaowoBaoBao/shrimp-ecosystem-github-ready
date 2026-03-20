#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDirs, loadConfig, loadState, loadControl, saveControl, saveState, appendLedger, addEvent,
  updateLeaderboard, classifyRegime, fetchTickersDetailed, num, estimateExecutionCost, normalizeSeatGene, clamp,
  ensureAllAgentMemories, appendAgentMemory, assignExecutionSlots, executeOrderPlan, applyKillSwitchBroadcast, replayAudit
} from './lib/runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  addEvent(state, { type: 'CONTROL', level: 'WARN', text: '引擎处于暂停状态，本轮 round_tick 跳过' });
  appendLedger('decision_ledger', { ts: new Date().toISOString(), type: 'ROUND_SKIPPED', reason: 'engineDisabled' });
  saveState(state);
  console.log('⏸️ round_tick skipped: engine disabled');
  process.exit(0);
}

const instrumentCsv = process.env.SHRIMP_INSTRUMENTS || cfg?.runtime?.instruments || 'BTC-USDT,ETH-USDT,SOL-USDT';
const instruments = instrumentCsv.split(',').map(s => s.trim()).filter(Boolean);
const tickerRetryAttempts = Math.max(1, Math.min(5, num(cfg?.runtime?.ticker_retry_attempts, 3)));
const fetchRes = fetchTickersDetailed(instruments, { maxAttempts: tickerRetryAttempts });
let tickers = Array.isArray(fetchRes.tickers) ? [...fetchRes.tickers] : [];

const prevMarketTickers = Array.isArray(state?.market?.tickers) ? state.market.tickers : [];
const prevTickerMap = Object.fromEntries(prevMarketTickers.map(x => [String(x.instId || ''), x]));
const fetchedSet = new Set(tickers.map(x => String(x.instId || '')));
let reusedFromCache = 0;

for (const instId of instruments) {
  if (fetchedSet.has(instId)) continue;
  const prev = prevTickerMap[instId];
  if (!prev) continue;
  // 仅回填缺失标的，避免整轮被单点网络抖动打断
  tickers.push({
    instId,
    last: prev.last,
    open24h: prev.open24h || prev.last,
    high24h: prev.high24h || prev.last,
    low24h: prev.low24h || prev.last,
    bidPx: prev.bidPx || prev.last,
    askPx: prev.askPx || prev.last,
    stale: true,
    source: 'cache'
  });
  reusedFromCache += 1;
}

if (fetchRes.failed > 0) {
  const failBrief = fetchRes.failures.map(x => `${x.instId}(x${x.attempts})`).join(', ');
  addEvent(state, {
    type: 'DATA',
    level: fetchRes.success > 0 || reusedFromCache > 0 ? 'WARN' : 'RED',
    text: `行情拉取部分失败：${failBrief}${reusedFromCache > 0 ? `（已回填${reusedFromCache}个缓存标的）` : ''}`
  });
  appendLedger('decision_ledger', {
    ts: new Date().toISOString(),
    type: 'MARKET_FETCH_WARN',
    requested: fetchRes.requested,
    success: fetchRes.success,
    failed: fetchRes.failed,
    reusedFromCache,
    failures: fetchRes.failures
  });
}

if (tickers.length === 0) {
  addEvent(state, { type: 'DATA', level: 'WARN', text: 'round_tick 未拉到行情，保留上一轮状态' });
  saveState(state);
  process.exit(0);
}

const stats = tickers.map(t => {
  const last = num(t.last);
  const open = num(t.open24h, last);
  const high = num(t.high24h, last);
  const low = num(t.low24h, last);
  const bid = num(t.bidPx, last);
  const ask = num(t.askPx, last);
  const ch = open ? ((last - open) / open) * 100 : 0;
  const range = low ? ((high - low) / low) * 100 : 0;
  const spreadBps = bid ? ((ask - bid) / bid) * 10000 : 0;
  return { instId: t.instId, last, ch, range, spreadBps };
});

const avgChangePct = stats.reduce((a, b) => a + b.ch, 0) / stats.length;
const avgRangePct = stats.reduce((a, b) => a + b.range, 0) / stats.length;
const avgSpreadBps = stats.reduce((a, b) => a + b.spreadBps, 0) / stats.length;
const regime = classifyRegime({ avgChangePct, avgRangePct });

state.regime = regime;
state.market = {
  avgChangePct: Number(avgChangePct.toFixed(3)),
  avgRangePct: Number(avgRangePct.toFixed(3)),
  avgSpreadBps: Number(avgSpreadBps.toFixed(2)),
  fetch: {
    requested: fetchRes.requested,
    success: fetchRes.success,
    failed: fetchRes.failed,
    reusedFromCache,
    retryAttempts: tickerRetryAttempts,
    failures: fetchRes.failures
  },
  tickers: stats
};

const fitBonus = {
  'A1': regime === 'Range' ? 0.22 : 0.03,
  'A2': regime === 'Trend' ? 0.22 : -0.08,
  'A3': regime === 'Range' ? 0.24 : -0.06,
  'A4': regime === 'Trend' ? 0.18 : -0.04,
  'A5': regime === 'High-Vol' ? 0.20 : 0.02,
  'A6': 0.12
};

const defaultInstBySeat = {
  A1: 'BTC-USDT',
  A2: 'ETH-USDT',
  A3: 'BTC-USDT',
  A4: 'SOL-USDT',
  A5: 'ETH-USDT',
  A6: 'BTC-USDT'
};
const defaultMarkByInst = {
  'BTC-USDT': 95000,
  'ETH-USDT': 3300,
  'SOL-USDT': 160
};
const defaultSideBySeat = { A1: 'long', A2: 'short', A3: 'long', A4: 'short', A5: 'long', A6: 'long' };
const defaultLeverageBySeat = { A1: 2, A2: 2, A3: 1, A4: 2, A5: 3, A6: 1 };
const defaultQtyBySeat = { A1: 0.2, A2: 3, A3: 0.1, A4: 90, A5: 2.2, A6: 0.08 };
const tickerMap = Object.fromEntries(stats.map(x => [x.instId, x]));

const cfWindow = Math.max(20, Math.min(400, Number(cfg?.execution?.counterfactual_window || 120)));
const cfMinSamples = Math.max(8, Math.min(200, Number(cfg?.execution?.counterfactual_min_samples || 40)));
const cfAlphaScale = Math.max(0.5, Math.min(20, Number(cfg?.execution?.counterfactual_alpha_scale || 8)));

const scoreWeights = {
  RQ: Number(cfg?.scoring?.RQ || 0.25),
  CF: Number(cfg?.scoring?.CF || 0.2),
  RC: Number(cfg?.scoring?.RC || 0.25),
  ES: Number(cfg?.scoring?.ES || 0.15),
  CP: Number(cfg?.scoring?.CP || 0.15)
};

function normalizeTo10(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 5;
  if (x <= lo) return 0;
  if (x >= hi) return 10;
  return Number((((x - lo) / (hi - lo)) * 10).toFixed(2));
}

function buildScoreBreakdown(seat, env = {}) {
  const rq = normalizeTo10(num(seat?.pnl24h, 0), -4, 4);
  const cfRaw = num(seat?.counterfactual?.decisionAlpha, 0) * 1000 * (0.5 + num(seat?.counterfactual?.confidence, 0));
  const cf = normalizeTo10(cfRaw, -2.5, 2.5);

  const drawdownPenalty = clamp(num(env?.risk?.drawdownDayPct, 1), 0, 5) / 5;
  const leveragePenalty = clamp(num(seat?.position?.leverage, 1) / Math.max(1, num(cfg?.risk?.max_leverage, 5)), 0, 2);
  const rc = Number((10 - drawdownPenalty * 3.5 - leveragePenalty * 2.2).toFixed(2));

  const seatExec = seat?.executionHealth || {};
  const esPenalty = clamp(num(seatExec.rejectRate, 0), 0, 1) * 4.5 + clamp(num(seatExec.timeoutRate, 0), 0, 1) * 3.0 + clamp(num(seatExec.avgLatencyMs, 0) / 5000, 0, 1) * 2.5;
  const es = Number((10 - esPenalty).toFixed(2));

  const hardViol = num(seat?.riskFlags?.hardViolations, 0);
  const cp = Number((Math.max(0, 10 - hardViol * 3.3)).toFixed(2));

  const total = Number((
    clamp(rq, 0, 10) * scoreWeights.RQ +
    clamp(cf, 0, 10) * scoreWeights.CF +
    clamp(rc, 0, 10) * scoreWeights.RC +
    clamp(es, 0, 10) * scoreWeights.ES +
    clamp(cp, 0, 10) * scoreWeights.CP
  ).toFixed(2));

  return {
    RQ: Number(clamp(rq, 0, 10).toFixed(2)),
    CF: Number(clamp(cf, 0, 10).toFixed(2)),
    RC: Number(clamp(rc, 0, 10).toFixed(2)),
    ES: Number(clamp(es, 0, 10).toFixed(2)),
    CP: Number(clamp(cp, 0, 10).toFixed(2)),
    total
  };
}

function buildAbAutoStatus(state, cfg = {}) {
  const abCfg = cfg?.ab_test || {};
  const minSamplesPerWindow = Math.max(3, Number(abCfg.min_samples_per_window || 12));
  const now = Date.now();
  const variantWindowMs = Math.max(1, Number(abCfg.variant_window_days || 7)) * 24 * 3600 * 1000;
  const baselineWindowMs = Math.max(1, Number(abCfg.baseline_window_days || 7)) * 24 * 3600 * 1000;
  const variantStart = now - variantWindowMs;
  const baselineStart = variantStart - baselineWindowMs;

  const inRange = (ts, start, end) => {
    const ms = Date.parse(ts || 0);
    return Number.isFinite(ms) && ms >= start && ms < end;
  };

  const daSource = (state.metrics?.decisionAlphaRtSeries && state.metrics.decisionAlphaRtSeries.length > 0)
    ? state.metrics.decisionAlphaRtSeries
    : (state.metrics?.decisionAlphaSeries || []);
  const eqSource = state.metrics?.accountEquitySeries || [];

  const sampleSizes = {
    decisionAlphaBaseline: daSource.filter(x => inRange(x.ts, baselineStart, variantStart)).length,
    decisionAlphaVariant: daSource.filter(x => inRange(x.ts, variantStart, now)).length,
    equityBaseline: eqSource.filter(x => inRange(x.ts, baselineStart, variantStart)).length,
    equityVariant: eqSource.filter(x => inRange(x.ts, variantStart, now)).length
  };

  const sampleGap = {
    decisionAlphaBaseline: Math.max(0, minSamplesPerWindow - sampleSizes.decisionAlphaBaseline),
    decisionAlphaVariant: Math.max(0, minSamplesPerWindow - sampleSizes.decisionAlphaVariant),
    equityBaseline: Math.max(0, minSamplesPerWindow - sampleSizes.equityBaseline),
    equityVariant: Math.max(0, minSamplesPerWindow - sampleSizes.equityVariant)
  };

  const ready =
    sampleSizes.decisionAlphaBaseline >= minSamplesPerWindow &&
    sampleSizes.decisionAlphaVariant >= minSamplesPerWindow &&
    sampleSizes.equityBaseline >= minSamplesPerWindow &&
    sampleSizes.equityVariant >= minSamplesPerWindow;

  return {
    enabled: abCfg.enabled !== false,
    autoRunOnSampleReady: abCfg.auto_run_on_sample_ready !== false,
    minSamplesPerWindow,
    sampleSizes,
    sampleGap,
    ready,
    status: ready ? 'READY' : 'WAITING_SAMPLES',
    updatedAt: new Date().toISOString()
  };
}

for (const seat of state.seats) {
  seat.obsRounds = Math.max(0, Number(seat.obsRounds || 0)) + 1;
  const noise = ((Math.sin(Date.now() / 100000 + seat.id.charCodeAt(1)) + 1) / 2 - 0.5) * 0.08;
  const perfSignal = (fitBonus[seat.id] ?? 0) - avgSpreadBps / 1000 + noise;

  const instId = seat.position?.instId || defaultInstBySeat[seat.id] || stats[0].instId;
  let mk = tickerMap[instId]?.last ?? num(seat.position?.markPx, 0);
  if (!mk || mk <= 0) mk = defaultMarkByInst[instId] || stats.find(x => x.last > 0)?.last || 1;
  const side = seat.position?.side || defaultSideBySeat[seat.id] || 'long';
  seat.gene = normalizeSeatGene(seat, {
    leverage: defaultLeverageBySeat[seat.id] || 1,
    regime_bias: seat.regimeFit || 'All',
    agent_role_id: seat.id,
    prompt_gene_version: 'v4.5-lite'
  });
  seat.prompt_gene_version = seat.gene.prompt_gene_version;
  seat.risk_profile = seat.gene.risk_profile;
  seat.agent_role_id = seat.gene.agent_role_id;

  const leverage = Math.max(1, num(seat.gene?.leverage, num(seat.position?.leverage, defaultLeverageBySeat[seat.id] || 1)));
  const oldQty = Math.max(0.0001, num(seat.position?.qty, defaultQtyBySeat[seat.id] || 0.01));
  const oldEntry = Math.max(0.0001, num(seat.position?.entryPx, mk || 1));
  const prevMark = Math.max(0.0001, num(seat.position?.markPx, mk));

  // 若行情短时静止（last 与上轮几乎一致），在 shadow 模式下注入极小漂移，避免长期“全0未实现PnL”的假象
  if (!state.mode?.demo_trade && Math.abs(mk - prevMark) < 1e-8) {
    const drift = (avgChangePct / 100) * 0.04 + noise * 0.001;
    mk = Number(Math.max(0.0001, mk * (1 + drift)).toFixed(4));
  }

  // 1) 决策反事实：执行 vs 不交易 vs 反向
  const priceMove = prevMark > 0 ? (mk - prevMark) / prevMark : 0;
  const executedOutcome = side === 'long' ? priceMove : -priceMove;
  const noTradeOutcome = 0;
  const inverseOutcome = -executedOutcome;

  const cfSamples = Array.isArray(seat?.counterfactual?.samples) ? [...seat.counterfactual.samples] : [];
  cfSamples.push({
    ts: new Date().toISOString(),
    executed: Number(executedOutcome.toFixed(6)),
    noTrade: Number(noTradeOutcome.toFixed(6)),
    inverse: Number(inverseOutcome.toFixed(6))
  });
  while (cfSamples.length > cfWindow) cfSamples.shift();

  const cfN = Math.max(1, cfSamples.length);
  const avgExecuted = cfSamples.reduce((a, x) => a + num(x.executed), 0) / cfN;
  const avgNoTrade = cfSamples.reduce((a, x) => a + num(x.noTrade), 0) / cfN;
  const avgInverse = cfSamples.reduce((a, x) => a + num(x.inverse), 0) / cfN;
  const daVsNoTrade = avgExecuted - avgNoTrade;
  const daVsInverse = avgExecuted - avgInverse;
  const counterfactualDA = (daVsNoTrade + daVsInverse) / 2;
  const winCount = cfSamples.filter(x => num(x.executed) > Math.max(num(x.noTrade), num(x.inverse))).length;
  const winRate = winCount / cfN;
  const sampleFactor = Math.min(1, cfN / cfMinSamples);
  const edgeFactor = Math.min(1, Math.abs(counterfactualDA) * 12);
  const confidence = Number((sampleFactor * (0.65 + edgeFactor * 0.35)).toFixed(4));
  const cfDaScaled = counterfactualDA * cfAlphaScale;

  seat.counterfactual = {
    samples: cfSamples,
    window: cfN,
    avgExecuted: Number(avgExecuted.toFixed(6)),
    avgNoTrade: Number(avgNoTrade.toFixed(6)),
    avgInverse: Number(avgInverse.toFixed(6)),
    daVsNoTrade: Number(daVsNoTrade.toFixed(6)),
    daVsInverse: Number(daVsInverse.toFixed(6)),
    decisionAlpha: Number(counterfactualDA.toFixed(6)),
    confidence,
    winRate: Number(winRate.toFixed(4)),
    minSamples: cfMinSamples,
    updatedAt: new Date().toISOString()
  };

  seat.decisionAlpha24h = Number((num(seat.decisionAlpha24h, 0) * 0.55 + cfDaScaled * 0.45).toFixed(3));

  const targetQty = Math.max(0.0001, Number((oldQty * (1 + perfSignal * 0.08)).toFixed(4)));
  const qtyDeltaAbs = Math.abs(targetQty - oldQty);
  const qtyDeltaRel = oldQty > 0 ? qtyDeltaAbs / oldQty : 1;
  const tradeThresholdRel = 0.02; // 仅在变动>=2%时视为发生“交易”并重算均价
  const tradeExecuted = qtyDeltaRel >= tradeThresholdRel;

  const nextQty = tradeExecuted ? targetQty : oldQty;
  let entryPx = oldEntry;
  if (tradeExecuted) {
    if (nextQty >= oldQty) {
      const blendedEntry = oldQty > 0
        ? ((oldEntry * oldQty) + (mk * (nextQty - oldQty))) / nextQty
        : mk;
      entryPx = Number(Math.max(0.0001, blendedEntry || mk || oldEntry).toFixed(4));
    } else {
      // 减仓不改变剩余仓位成本价
      entryPx = oldEntry;
    }
  }

  // 2) 交易成本模型：手续费 + 半边价差 + 深度滑点
  const spreadBps = num(tickerMap[instId]?.spreadBps, avgSpreadBps);
  const deltaQty = Math.abs(nextQty - oldQty);
  const tradeNotionalUsd = tradeExecuted ? Number((deltaQty * mk).toFixed(4)) : 0;
  const cost = estimateExecutionCost({ cfg, notionalUsd: tradeNotionalUsd, spreadBps });
  const tradeCostUsd = tradeExecuted ? cost.estCostUsd : 0;

  const ratio = entryPx ? (side === 'long' ? (mk - entryPx) / entryPx : (entryPx - mk) / entryPx) : 0;
  const notional = Number((nextQty * mk).toFixed(2));
  const unrealizedPnlRaw = Number((nextQty * entryPx * ratio).toFixed(2));
  const unrealizedPnl = Number((unrealizedPnlRaw - tradeCostUsd).toFixed(2));
  const marginUsed = Number((notional / leverage).toFixed(2));

  const slPct = clamp(num(seat?.gene?.sl, 0.015), 0.001, 0.5);
  const tpPct = clamp(num(seat?.gene?.tp, 0.03), 0.001, 1.5);
  const stopLossPx = side === 'long'
    ? Number((entryPx * (1 - slPct)).toFixed(4))
    : Number((entryPx * (1 + slPct)).toFixed(4));
  const takeProfitPx = side === 'long'
    ? Number((entryPx * (1 + tpPct)).toFixed(4))
    : Number((entryPx * (1 - tpPct)).toFixed(4));

  const costPenalty = tradeExecuted && prevMark > 0 ? (tradeCostUsd / Math.max(1, prevMark * oldQty)) * 100 : 0;
  const pnlDriver = perfSignal * 1.4 + cfDaScaled * 0.8 - costPenalty;
  seat.pnl24h = Number((num(seat.pnl24h, 0) * 0.72 + pnlDriver * 0.28).toFixed(2));

  seat.executionHealth = seat.executionHealth || { rejectRate: 0, timeoutRate: 0, avgLatencyMs: 0, retryRecoveryRate: 0 };
  seat.riskFlags = {
    hardViolations: Number(seat?.riskFlags?.hardViolations || 0),
    noStopLoss: !Number.isFinite(stopLossPx),
    overLeverage: leverage > Math.max(1, num(cfg?.risk?.max_leverage, 5))
  };

  const scoreBreakdown = buildScoreBreakdown(seat, { risk: state.risk || {} });
  seat.scoreBreakdown = scoreBreakdown;
  const nextScore = Math.max(5.2, Math.min(9.8, num(seat.score, 7.2) * 0.6 + scoreBreakdown.total * 0.4));
  seat.score = Number(nextScore.toFixed(2));

  seat.position = {
    kind: state.mode?.demo_trade ? 'demo' : 'shadow',
    instId,
    side,
    qty: nextQty,
    entryPx,
    markPx: Number(mk.toFixed(4)),
    leverage,
    notional,
    unrealizedPnl,
    tradeCostUsd: Number(tradeCostUsd.toFixed(4)),
    tradeCostBps: cost.totalCostBps,
    stopLossPx,
    takeProfitPx,
    slPct: Number(slPct.toFixed(4)),
    tpPct: Number(tpPct.toFixed(4)),
    changePct: Number((ratio * 100).toFixed(2)),
    marginUsed,
    tradeExecuted,
    lastTradeAt: tradeExecuted ? new Date().toISOString() : (seat.position?.lastTradeAt || null)
  };

  appendAgentMemory(seat.id, {
    type: 'ROUND_OBS',
    regime,
    score: seat.score,
    scoreBreakdown: seat.scoreBreakdown,
    state: seat.state,
    obsRounds: seat.obsRounds,
    decisionAlpha24h: seat.decisionAlpha24h,
    pnl24h: seat.pnl24h,
    gene: seat.gene,
    perf: Number(perfSignal.toFixed(4)),
    counterfactual: {
      decisionAlpha: seat.counterfactual?.decisionAlpha,
      confidence: seat.counterfactual?.confidence,
      winRate: seat.counterfactual?.winRate,
      samples: seat.counterfactual?.window
    },
    cost,
    position: {
      instId,
      side,
      qty: nextQty,
      entryPx,
      markPx: Number(mk.toFixed(4)),
      unrealizedPnl,
      stopLossPx,
      takeProfitPx,
      tradeExecuted
    },
    market: {
      avgChangePct: Number(avgChangePct.toFixed(3)),
      avgRangePct: Number(avgRangePct.toFixed(3)),
      avgSpreadBps: Number(avgSpreadBps.toFixed(2))
    }
  });
}

const da = state.seats.reduce((a, b) => a + b.decisionAlpha24h, 0) / state.seats.length;
const cfAvg = state.seats.reduce((a, b) => a + num(b?.counterfactual?.decisionAlpha, 0), 0) / Math.max(1, state.seats.length);
const cfConfidenceAvg = state.seats.reduce((a, b) => a + num(b?.counterfactual?.confidence, 0), 0) / Math.max(1, state.seats.length);

state.metrics = state.metrics || {};
state.metrics.decisionAlphaSeries = state.metrics.decisionAlphaSeries || [];
state.metrics.decisionAlphaRtSeries = state.metrics.decisionAlphaRtSeries || [];
state.metrics.counterfactualSeries = state.metrics.counterfactualSeries || [];
state.metrics.scoreSeries = state.metrics.scoreSeries || [];
state.metrics.counterfactualSummary = {
  avgDecisionAlpha: Number(cfAvg.toFixed(6)),
  avgConfidence: Number(cfConfidenceAvg.toFixed(4)),
  minSamples: cfMinSamples,
  window: cfWindow,
  updatedAt: new Date().toISOString()
};

const nowTs = new Date().toISOString();
const day = nowTs.slice(0, 10);

// 日级聚合（面向看板总览）
const idx = state.metrics.decisionAlphaSeries.findIndex(x => x.ts === day);
if (idx >= 0) state.metrics.decisionAlphaSeries[idx].value = Number(da.toFixed(3));
else state.metrics.decisionAlphaSeries.push({ ts: day, value: Number(da.toFixed(3)) });
state.metrics.decisionAlphaSeries = state.metrics.decisionAlphaSeries.slice(-60);

// 轮级采样（面向 A/B 统计，解决样本不足）
state.metrics.decisionAlphaRtSeries.push({ ts: nowTs, value: Number(da.toFixed(6)) });
state.metrics.decisionAlphaRtSeries = state.metrics.decisionAlphaRtSeries.slice(-2000);

const scoreAvg = state.seats.reduce((a, b) => a + num(b.score, 0), 0) / Math.max(1, state.seats.length);
const scoreIdx = state.metrics.scoreSeries.findIndex(x => x.ts === day);
if (scoreIdx >= 0) state.metrics.scoreSeries[scoreIdx].value = Number(scoreAvg.toFixed(3));
else state.metrics.scoreSeries.push({ ts: day, value: Number(scoreAvg.toFixed(3)) });
state.metrics.scoreSeries = state.metrics.scoreSeries.slice(-60);

const cfIdx = state.metrics.counterfactualSeries.findIndex(x => x.ts === day);
if (cfIdx >= 0) {
  state.metrics.counterfactualSeries[cfIdx].value = Number(cfAvg.toFixed(6));
  state.metrics.counterfactualSeries[cfIdx].confidence = Number(cfConfidenceAvg.toFixed(4));
} else {
  state.metrics.counterfactualSeries.push({ ts: day, value: Number(cfAvg.toFixed(6)), confidence: Number(cfConfidenceAvg.toFixed(4)) });
}
state.metrics.counterfactualSeries = state.metrics.counterfactualSeries.slice(-60);

const marginUsed = Number(state.seats.reduce((a, b) => a + num(b.position?.marginUsed), 0).toFixed(2));
const unrealizedPnl = Number(state.seats.reduce((a, b) => a + num(b.position?.unrealizedPnl), 0).toFixed(2));
const tradeCostRound = Number(state.seats.reduce((a, b) => a + num(b.position?.tradeCostUsd), 0).toFixed(4));
const prevEquity = num(state.account?.equity, 100000);
const pnlDrift = da * 120 + unrealizedPnl * 0.03;
const equity = Number(Math.max(2000, prevEquity + pnlDrift).toFixed(2));
const realizedPnl24h = Number((num(state.account?.realizedPnl24h, 0) * 0.85 + da * 90 - tradeCostRound * 2).toFixed(2));
const available = Number(Math.max(0, equity - marginUsed).toFixed(2));

state.account = {
  profile: state.account?.profile || (state.mode?.demo_trade ? 'demo' : 'shadow'),
  mode: state.mode?.demo_trade ? 'demo' : 'shadow',
  equity,
  available,
  marginUsed,
  unrealizedPnl,
  tradeCostRound,
  realizedPnl24h,
  pnl24h: Number((realizedPnl24h + unrealizedPnl).toFixed(2)),
  updatedAt: new Date().toISOString()
};

state.metrics.accountEquitySeries = state.metrics.accountEquitySeries || [];
if (state.metrics.accountEquitySeries.length === 0) {
  // 首轮先补一个上一时刻样本，避免曲线只有单点不可见
  state.metrics.accountEquitySeries.push({
    ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    value: prevEquity
  });
}
state.metrics.accountEquitySeries.push({ ts: new Date().toISOString(), value: equity });
state.metrics.accountEquitySeries = state.metrics.accountEquitySeries.slice(-80);
state.metrics.executionCostSeries = state.metrics.executionCostSeries || [];
state.metrics.executionCostSeries.push({ ts: new Date().toISOString(), value: tradeCostRound });
state.metrics.executionCostSeries = state.metrics.executionCostSeries.slice(-120);

const riskCfg = cfg?.risk || {};
const triggerCfg = riskCfg?.triggers || {};
const rangeYellow = Math.max(1, num(triggerCfg.range_yellow_pct, 4));
const rangeRed = Math.max(rangeYellow + 0.5, num(triggerCfg.range_red_pct, 8));
const spreadYellow = Math.max(1, num(triggerCfg.spread_yellow_bps, 5));
const spreadRed = Math.max(spreadYellow + 0.5, num(triggerCfg.spread_red_bps, 10));
const changeYellow = Math.max(0.5, num(triggerCfg.change_yellow_pct, 2));
const changeRed = Math.max(changeYellow + 0.5, num(triggerCfg.change_red_pct, 4));
const yellowTriggerCount = Math.max(1, Math.round(num(triggerCfg.yellow_trigger_count, 2)));
const redTriggerCount = Math.max(yellowTriggerCount + 1, Math.round(num(triggerCfg.red_trigger_count, 4)));
const redConsecutiveRounds = Math.max(1, Math.round(num(triggerCfg.red_consecutive_rounds, 2)));

const rangeScore = avgRangePct >= rangeRed ? 2 : (avgRangePct >= rangeYellow ? 1 : 0);
const spreadScore = avgSpreadBps >= spreadRed ? 2 : (avgSpreadBps >= spreadYellow ? 1 : 0);
const changeScore = Math.abs(avgChangePct) >= changeRed ? 2 : (Math.abs(avgChangePct) >= changeYellow ? 1 : 0);
const dataScore = fetchRes.failed >= Math.ceil(Math.max(1, fetchRes.requested) * 0.5) ? 1 : 0;
const triggerCount = rangeScore + spreadScore + changeScore + dataScore;

const prevDrawdownDay = num(state?.risk?.drawdownDayPct, 0.8);
const prevDrawdownWeek = num(state?.risk?.drawdownWeekPct, 2.4);
const drawdownDayPct = Number(clamp(prevDrawdownDay * 0.55 + Math.max(0, -da) * 1.25 + Math.abs(avgChangePct) * 0.06, 0.2, 4.8).toFixed(2));
const drawdownWeekPct = Number(clamp(prevDrawdownWeek * 0.72 + drawdownDayPct * 0.55 + Math.max(0, -cfAvg) * 40 * 0.08, 1.0, 10.5).toFixed(2));

const ddDayLimit = Math.max(0.5, num(riskCfg?.daily_drawdown_limit_pct, 2));
const ddWeekLimit = Math.max(1.5, num(riskCfg?.weekly_drawdown_limit_pct, 6));
const hardRiskBreach =
  drawdownDayPct >= ddDayLimit * 1.5 ||
  drawdownWeekPct >= ddWeekLimit * 1.3 ||
  ((drawdownDayPct >= ddDayLimit * 1.2 || drawdownWeekPct >= ddWeekLimit * 1.15) && triggerCount >= redTriggerCount);

state.risk = state.risk || {};
state.risk.redStreak = triggerCount >= redTriggerCount ? Number(state.risk.redStreak || 0) + 1 : 0;

let riskLevel = 'GREEN';
if (hardRiskBreach || (triggerCount >= redTriggerCount && state.risk.redStreak >= redConsecutiveRounds)) {
  riskLevel = 'RED';
} else if (triggerCount >= yellowTriggerCount) {
  riskLevel = 'YELLOW';
}

state.risk.a6Trigger30m = triggerCount;
state.risk.level = riskLevel;
state.risk.drawdownDayPct = drawdownDayPct;
state.risk.drawdownWeekPct = drawdownWeekPct;
state.risk.components = {
  rangeScore,
  spreadScore,
  changeScore,
  dataScore,
  yellowTriggerCount,
  redTriggerCount,
  redConsecutiveRounds
};
state.risk.action = riskLevel === 'RED' ? '建议降低仓位到20%以下并暂停新开仓' : riskLevel === 'YELLOW' ? '建议减仓并收紧止损' : '风险可控，按影子计划执行';

const ksUntilMs = Date.parse(state?.risk?.killSwitchCooldownUntil || 0);
if (state?.risk?.killSwitchActive && Number.isFinite(ksUntilMs) && Date.now() >= ksUntilMs) {
  state.risk.killSwitchActive = false;
  state.execution = state.execution || {};
  state.execution.orderWritePaused = false;
  state.execution.orderWritePausedUntil = null;
  addEvent(state, { type: 'KILL_SWITCH', level: 'INFO', text: 'Kill Switch 冷却期结束，写单冻结已自动解除' });
}

if (riskLevel === 'RED') {
  addEvent(state, { type: 'A6_ALERT', level: 'RED', text: `触发 Kill Switch 条件：停新单→撤挂单→reduceOnly（score=${triggerCount} streak=${state.risk.redStreak}）` });
}

const ksCfg = cfg?.risk?.kill_switch || {};
const autoKill = ksCfg.auto_on_red !== false;
const redThreshold = Math.max(1, Number(ksCfg.a6_trigger_30m_red || redTriggerCount));
const cooldownMinutes = Math.max(5, Number(ksCfg.cooldown_minutes || 60));
const shouldAutoKill = autoKill && riskLevel === 'RED' && triggerCount >= redThreshold;

if (shouldAutoKill) {
  const nextAllowedAtMs = Date.parse(state?.risk?.killSwitchCooldownUntil || 0);
  const cooldownActive = Number.isFinite(nextAllowedAtMs) && Date.now() < nextAllowedAtMs;

  if (!cooldownActive) {
    const ks = applyKillSwitchBroadcast(state, {
      execute: ksCfg.execute_actions !== false,
      allowLive: !!cfg?.execution?.allow_live_write,
      pauseMinutes: cooldownMinutes,
      maxCancelPerProfile: Number(ksCfg.max_cancel_orders || 20),
      maxClosePositions: Number(ksCfg.max_close_positions || 10)
    });

    const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    state.risk.killSwitchActive = true;
    state.risk.killSwitchLastAt = new Date().toISOString();
    state.risk.killSwitchCooldownUntil = cooldownUntil;

    control.engineEnabled = false;
    control.mode = { shadow_only: true, demo_trade: false };
    control.writeArmed = false;
    control.writeArmUntil = null;
    saveControl(control);
    state.mode = control.mode;

    addEvent(state, {
      type: 'KILL_SWITCH',
      level: 'RED',
      text: `A6 自动触发已执行（profiles=${ks?.profiles?.length || 0}，冷却至 ${cooldownUntil}）`
    });

    appendLedger('execution_ledger', {
      ts: new Date().toISOString(),
      type: 'KILL_SWITCH',
      trigger: 'A6_AUTO_RED',
      triggerCount,
      riskLevel,
      cooldownUntil,
      detail: ks
    });
  } else {
    addEvent(state, {
      type: 'KILL_SWITCH',
      level: 'WARN',
      text: `A6 红警命中但仍在冷却期，跳过重复触发（until=${state?.risk?.killSwitchCooldownUntil}）`
    });
  }
}

const gateEnabled = cfg?.execution?.evolution_exec_gate_enabled !== false;
const autoReplayOnGate = gateEnabled && cfg?.execution?.evolution_auto_replay_on_gate !== false;
const hasPendingGate = (state.seats || []).some(s => s?.execGate?.required);
if (autoReplayOnGate && hasPendingGate) {
  const replay = replayAudit(state, cfg);
  state.audit = state.audit || {};
  state.audit.replayStatus = replay.status;
  state.audit.missingRows = replay.missingRows;
  state.audit.replayIssues = replay.issues;
  state.audit.replayLedgers = replay.ledgers;
  state.audit.replayCheckedAt = replay.checkedAt;

  appendLedger('execution_ledger', {
    ts: new Date().toISOString(),
    type: 'GATE_REPLAY_CHECK',
    status: replay.status,
    issues: replay.issues,
    missingRows: replay.missingRows
  });
}

updateLeaderboard(state);
const execView = assignExecutionSlots(state, cfg, { force: true });

let releasedExecGates = 0;
for (const seat of (state.seats || [])) {
  if (!seat?.execGate?.required) continue;
  if (seat.executionMode !== 'exec') {
    seat.execGate.shadowRounds = Number(seat.execGate.shadowRounds || 0) + 1;
    seat.execGate.status = seat.execEligibility?.eligible ? 'READY' : 'PENDING';
    continue;
  }

  if (seat.execEligibility?.eligible) {
    seat.execGate = {
      ...seat.execGate,
      required: false,
      status: 'OPEN',
      passedAt: new Date().toISOString(),
      reason: 'gate-passed-to-exec'
    };
    releasedExecGates += 1;
  }
}
if (releasedExecGates > 0) {
  addEvent(state, { type: 'EXEC_GATE', level: 'INFO', text: `有 ${releasedExecGates} 个进化席位通过上线闸门并进入 EXEC` });
}

const execRun = executeOrderPlan(state, cfg, {
  allowWrite: !!state.mode?.demo_trade,
  control,
  writeRetries: Number(cfg?.execution?.write_retry_attempts || 1),
  enforceDemo: !cfg?.execution?.allow_live_write
});

const receiptByAgent = Object.fromEntries((execRun.receipts || []).map(r => [r.agentId, r]));
const hardViolByAgent = (execRun.plan?.skipped || []).reduce((m, x) => {
  if (x?.agentId && (x.hardViolation || String(x.reason || '').startsWith('hard-violation:'))) {
    m[x.agentId] = (m[x.agentId] || 0) + 1;
  }
  return m;
}, {});

for (const seat of (state.seats || [])) {
  const rr = receiptByAgent[seat.id] || {};
  seat.executionHealth = {
    rejectRate: rr.status === 'rejected' ? 1 : 0,
    timeoutRate: rr.timedOut ? 1 : 0,
    avgLatencyMs: Number(rr.latencyMs || 0),
    retryRecoveryRate: rr.retryRecovered ? 1 : 0
  };
  seat.riskFlags = seat.riskFlags || {};
  seat.riskFlags.hardViolations = Number(seat.riskFlags.hardViolations || 0) + Number(hardViolByAgent[seat.id] || 0);
}
state.risk = state.risk || {};
state.risk.hardViolations = Number(execRun?.summary?.hardViolations || 0);

if (state.mode?.demo_trade) {
  addEvent(state, {
    type: 'EXEC',
    level: 'INFO',
    text: `执行计划已生成：orders=${execRun.summary.total}, dryRun=${execRun.summary.dryRun}, skipped=${execRun.summary.skipped}`
  });
}

appendLedger('execution_ledger', {
  ts: new Date().toISOString(),
  type: 'ORDER_PLAN',
  mode: state.mode,
  summary: execRun.summary,
  receipts: execRun.receipts.slice(0, 20),
  skipped: execRun.plan.skipped.slice(0, 20)
});

const abAuto = buildAbAutoStatus(state, cfg);
state.metrics.abAuto = abAuto;

appendLedger('decision_ledger', {
  ts: new Date().toISOString(),
  type: 'ROUND',
  regime,
  market: state.market,
  account: state.account,
  execution: {
    policy: execView?.policy,
    assigned: execView?.assigned || [],
    shadowAgentIds: execView?.shadowAgentIds || [],
    orderRun: execRun?.summary || null
  },
  abAuto,
  seats: state.seats.map(s => ({
    id: s.id,
    score: s.score,
    scoreBreakdown: s.scoreBreakdown || null,
    da: s.decisionAlpha24h,
    daCf: s.counterfactual?.decisionAlpha,
    daConfidence: s.counterfactual?.confidence,
    pnl: s.pnl24h,
    execEligibility: s.execEligibility || null,
    execGate: s.execGate ? {
      required: !!s.execGate.required,
      status: s.execGate.status || null,
      reason: s.execGate.reason || null,
      shadowRounds: Number(s.execGate.shadowRounds || 0),
      minShadowRounds: Number(s.execGate.minShadowRounds || 0),
      replayStatus: s.execGate.replayStatus || null
    } : null,
    gene: s.gene ? {
      leverage: s.gene.leverage,
      sl: s.gene.sl,
      tp: s.gene.tp,
      regime_bias: s.gene.regime_bias,
      risk_profile: s.gene.risk_profile,
      agent_role_id: s.gene.agent_role_id,
      prompt_gene_version: s.gene.prompt_gene_version
    } : null,
    pos: s.position ? {
      instId: s.position.instId,
      side: s.position.side,
      qty: s.position.qty,
      upl: s.position.unrealizedPnl,
      tradeCostUsd: s.position.tradeCostUsd,
      stopLossPx: s.position.stopLossPx,
      takeProfitPx: s.position.takeProfitPx
    } : null
  })),
  risk: state.risk
});

saveState(state);

let autoAbRun = { triggered: false, status: 'skipped' };
if (abAuto.enabled && abAuto.autoRunOnSampleReady && abAuto.ready) {
  const cooldownMin = Math.max(5, Number(cfg?.ab_test?.auto_run_cooldown_minutes || 60));
  const lastAt = Date.parse(state?.metrics?.abExperiment?.updatedAt || 0);
  const cooldownActive = Number.isFinite(lastAt) && (Date.now() - lastAt) < cooldownMin * 60_000;

  if (cooldownActive) {
    autoAbRun = { triggered: false, status: 'cooldown', cooldownMin };
  } else {
    const runner = spawnSync(process.execPath, [join(__dirname, 'run_task.mjs'), 'ab_runner'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120000
    });
    const ok = Number(runner.status || 1) === 0;
    const stderr = String(runner.stderr || '').trim();
    const stdout = String(runner.stdout || '').trim();
    const brief = (stderr || stdout || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';

    autoAbRun = {
      triggered: true,
      status: ok ? 'ok' : 'failed',
      code: runner.status,
      brief: brief.slice(0, 220)
    };

    appendLedger('performance_ledger', {
      ts: new Date().toISOString(),
      type: 'AB_AUTO_RUN',
      ok,
      code: runner.status,
      brief,
      sampleSizes: abAuto.sampleSizes,
      minSamplesPerWindow: abAuto.minSamplesPerWindow
    });
  }
}

console.log('✅ round_tick done', {
  regime,
  avgChangePct: Number(avgChangePct.toFixed(3)),
  avgRangePct: Number(avgRangePct.toFixed(3)),
  riskLevel,
  marketFetch: `${fetchRes.success}/${fetchRes.requested}`,
  abAuto: {
    ready: abAuto.ready,
    status: abAuto.status,
    run: autoAbRun.status
  }
});
