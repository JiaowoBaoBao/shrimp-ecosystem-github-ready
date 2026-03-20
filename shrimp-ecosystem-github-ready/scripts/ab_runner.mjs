#!/usr/bin/env node
import { ensureDirs, loadConfig, loadState, saveState, appendLedger } from './lib/runtime.mjs';

ensureDirs();
const cfg = loadConfig();
const state = loadState();

if (!state) {
  console.error('state.json not found. Run: node scripts/run_task.mjs seed_state');
  process.exit(1);
}

const abCfg = cfg?.ab_test || {};
const lookbackDays = Math.max(7, Number(abCfg.lookback_days || 21));
const baselineWindowDays = Math.max(3, Number(abCfg.baseline_window_days || 7));
const variantWindowDays = Math.max(3, Number(abCfg.variant_window_days || 7));
const minSamplesPerWindow = Math.max(3, Number(abCfg.min_samples_per_window || 12));

const now = Date.now();
const lookbackStart = now - lookbackDays * 24 * 3600 * 1000;

function inRange(ts, start, end) {
  const ms = Date.parse(ts || 0);
  return Number.isFinite(ms) && ms >= start && ms < end;
}

function maxDrawdownPct(series = []) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of series) {
    const v = Number(p?.value || 0);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return Number(maxDd.toFixed(2));
}

function avg(arr = []) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const daSource = (state.metrics?.decisionAlphaRtSeries && state.metrics.decisionAlphaRtSeries.length > 0)
  ? state.metrics.decisionAlphaRtSeries
  : (state.metrics?.decisionAlphaSeries || []);

const daAll = daSource
  .filter(x => inRange(x.ts, lookbackStart, now))
  .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

const eqAll = (state.metrics?.accountEquitySeries || [])
  .filter(x => inRange(x.ts, lookbackStart, now))
  .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

const variantStart = now - variantWindowDays * 24 * 3600 * 1000;
const baselineStart = variantStart - baselineWindowDays * 24 * 3600 * 1000;

const daBaseline = daAll.filter(x => inRange(x.ts, baselineStart, variantStart)).map(x => Number(x.value || 0));
const daVariant = daAll.filter(x => inRange(x.ts, variantStart, now)).map(x => Number(x.value || 0));

const eqBaseline = eqAll.filter(x => inRange(x.ts, baselineStart, variantStart));
const eqVariant = eqAll.filter(x => inRange(x.ts, variantStart, now));

const evs = (state.events || []).filter(x => inRange(x.ts, baselineStart, now));
const haltBaseline = evs.filter(x => inRange(x.ts, baselineStart, variantStart) && ['A6_ALERT', 'KILL_SWITCH'].includes(String(x.type || ''))).length;
const haltVariant = evs.filter(x => inRange(x.ts, variantStart, now) && ['A6_ALERT', 'KILL_SWITCH'].includes(String(x.type || ''))).length;

const baseline = {
  decisionAlphaAvg: Number(avg(daBaseline).toFixed(4)),
  maxDrawdownPct: maxDrawdownPct(eqBaseline),
  halts: haltBaseline
};

const variant = {
  decisionAlphaAvg: Number(avg(daVariant).toFixed(4)),
  maxDrawdownPct: maxDrawdownPct(eqVariant),
  halts: haltVariant
};

const drawdownDropPct = baseline.maxDrawdownPct > 0
  ? Number((((baseline.maxDrawdownPct - variant.maxDrawdownPct) / baseline.maxDrawdownPct) * 100).toFixed(2))
  : 0;

const haltsDropPct = baseline.halts > 0
  ? Number((((baseline.halts - variant.halts) / baseline.halts) * 100).toFixed(2))
  : 0;

const sampleSizes = {
  decisionAlphaBaseline: daBaseline.length,
  decisionAlphaVariant: daVariant.length,
  equityBaseline: eqBaseline.length,
  equityVariant: eqVariant.length
};

const sampleOk =
  sampleSizes.decisionAlphaBaseline >= minSamplesPerWindow &&
  sampleSizes.decisionAlphaVariant >= minSamplesPerWindow &&
  sampleSizes.equityBaseline >= minSamplesPerWindow &&
  sampleSizes.equityVariant >= minSamplesPerWindow;

const sampleGap = {
  decisionAlphaBaseline: Math.max(0, minSamplesPerWindow - sampleSizes.decisionAlphaBaseline),
  decisionAlphaVariant: Math.max(0, minSamplesPerWindow - sampleSizes.decisionAlphaVariant),
  equityBaseline: Math.max(0, minSamplesPerWindow - sampleSizes.equityBaseline),
  equityVariant: Math.max(0, minSamplesPerWindow - sampleSizes.equityVariant)
};

const drawdownBetter = baseline.maxDrawdownPct > 0
  ? drawdownDropPct >= 15
  : variant.maxDrawdownPct <= Number(abCfg.max_drawdown_when_no_baseline_pct || 2.0);

const haltBetter = baseline.halts > 0
  ? haltsDropPct >= 20
  : variant.halts <= Number(abCfg.max_halts_when_no_baseline || 0);

const gates = {
  sampleOk,
  minSamplesPerWindow,
  sampleGap,
  status: sampleOk ? 'EVALUATED' : 'INSUFFICIENT_SAMPLE',
  decisionAlphaBetter: variant.decisionAlphaAvg > baseline.decisionAlphaAvg,
  drawdownBetter,
  haltBetter,
  drawdownDropPct,
  haltsDropPct,
  pass: sampleOk && variant.decisionAlphaAvg > baseline.decisionAlphaAvg && drawdownBetter && haltBetter
};

state.metrics = state.metrics || {};
state.metrics.abExperiment = {
  lookbackDays,
  baselineWindowDays,
  variantWindowDays,
  updatedAt: new Date().toISOString(),
  windows: {
    baselineStart: new Date(baselineStart).toISOString(),
    variantStart: new Date(variantStart).toISOString(),
    now: new Date(now).toISOString()
  },
  sampleSizes,
  baseline,
  variant,
  gates
};

state.metrics.abTest = {
  baseline: {
    decisionAlpha: baseline.decisionAlphaAvg,
    maxDrawdown: baseline.maxDrawdownPct,
    halts: baseline.halts
  },
  variant: {
    decisionAlpha: variant.decisionAlphaAvg,
    maxDrawdown: variant.maxDrawdownPct,
    halts: variant.halts
  }
};

appendLedger('performance_ledger', {
  ts: new Date().toISOString(),
  type: 'AB_RUNNER',
  baseline,
  variant,
  gates
});

saveState(state, { cfg });
console.log('✅ ab_runner done', { baseline, variant, gates });
