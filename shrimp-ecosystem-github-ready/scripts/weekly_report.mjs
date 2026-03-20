#!/usr/bin/env node
import { ensureDirs, loadState, OUTPUT_DIR, appendLedger } from './lib/runtime.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

ensureDirs();
const state = loadState();
if (!state) {
  console.error('state.json not found. Run: node scripts/generate_demo_state.mjs');
  process.exit(1);
}

const top = state.leaderboard?.top?.[0];
const bot = state.leaderboard?.bottom?.[0];
const ab = state.metrics?.abTest || { baseline: {}, variant: {} };
const abe = state.metrics?.abExperiment || {};
const aba = state.metrics?.abAuto || {};

const md = `# 🦐 虾系生态周报

- 时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}
- 当前 Regime: ${state.regime}
- 风险级别: ${state.risk?.level}（A6触发 ${state.risk?.a6Trigger30m}/30m）

## 榜单
- Top1: ${top?.id} ${top?.name}（Score ${top?.score}）
- Bottom1: ${bot?.id} ${bot?.name}（Score ${bot?.score}）

## A/B 对照
- DecisionAlpha: baseline=${ab.baseline.decisionAlpha} / variant=${ab.variant.decisionAlpha}
- MaxDrawdown: baseline=${ab.baseline.maxDrawdown}% / variant=${ab.variant.maxDrawdown}%
- Halts: baseline=${ab.baseline.halts} / variant=${ab.variant.halts}
- AutoHook: enabled=${aba?.enabled ? 'yes' : 'no'} / autoRun=${aba?.autoRunOnSampleReady ? 'yes' : 'no'} / status=${aba?.status || '-'}
- Gates: 状态=${abe?.gates?.status || '-'} / 样本充分=${abe?.gates?.sampleOk ? '是' : '否'}(${abe?.gates?.minSamplesPerWindow ?? '-'}) / DA更优=${abe?.gates?.decisionAlphaBetter ? '是' : '否'} / DD更优=${abe?.gates?.drawdownBetter ? '是' : '否'} / Halt更优=${abe?.gates?.haltBetter ? '是' : '否'} / DD下降=${abe?.gates?.drawdownDropPct ?? '-'}% / Halt下降=${abe?.gates?.haltsDropPct ?? '-'}% / 总体=${abe?.gates?.pass ? 'PASS' : 'WAIT'}

## 风控与审计
- 审计状态: ${state.audit?.replayStatus}
- daily_root_hash: ${state.audit?.dailyRootHash}

> 免责声明：仅作研究与风险提示，不构成投资建议。
`;

const out = join(OUTPUT_DIR, 'weekly-report.md');
writeFileSync(out, md);
appendLedger('performance_ledger', {
  ts: new Date().toISOString(),
  type: 'WEEKLY_REPORT',
  top: top?.id,
  bottom: bot?.id,
  regime: state.regime,
  riskLevel: state.risk?.level,
  abPass: abe?.gates?.pass || false
});

console.log('✅ weekly report written:', out);
