#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_DIR, STATE_PATH, loadConfig } from './lib/runtime.mjs';

function f2(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(d);
}

function pickAgentComment(seat = {}) {
  const cf = Number(seat?.counterfactual?.decisionAlpha || 0);
  const win = Number(seat?.counterfactual?.winRate || 0);
  const upnl = Number(seat?.position?.unrealizedPnl || 0);
  const state = String(seat?.state || '').toUpperCase();

  if (cf > 0.0006 && win >= 0.55) return '边际优势明显，可优先保留执行。';
  if (cf <= -0.0012 || win < 0.38) return '负边际偏强，建议降权或仅保留观测。';
  if (state === 'WARN') return '状态告警，建议先收缩风险暴露。';
  if (upnl > 0 && cf >= 0) return '短期表现尚可，继续观察稳定性。';
  if (upnl < 0 && cf < 0) return '浮亏与反事实同向，建议缩仓复核参数。';
  return '表现中性，建议维持小仓位跟踪。';
}

function buildAnalysis(state) {
  const seats = state?.seats || [];
  const risk = state?.risk || {};
  const account = state?.account || {};
  const execution = state?.execution || {};
  const top = state?.leaderboard?.top?.[0];
  const bottom = state?.leaderboard?.bottom?.[0];

  const activeCount = seats.filter(x => String(x?.state || '').toUpperCase() === 'ACTIVE').length;
  const warnCount = seats.filter(x => String(x?.state || '').toUpperCase() === 'WARN').length;
  const assigned = execution?.assigned || [];

  const pushEvent = (state?.events || []).find(x => x?.type === 'PUSH');

  const globalStatus = [
    `- 截面时间：${state?.generatedAt ? new Date(state.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`,
    `- Regime=${state?.regime || '-'} | 风险=${risk.level || '-'}(${risk.a6Trigger30m ?? '-'}/30m)`,
    `- 账户权益=${f2(account.equity)} | 可用=${f2(account.available)} | 24hPnL=${f2(account.pnl24h)}`,
    `- Agent状态：ACTIVE=${activeCount}，WARN=${warnCount}，EXEC=${assigned.length}，SHADOW=${Math.max(0, seats.length - assigned.length)}`,
    `- Top=${top?.id || '-'} ${top?.name || ''}(${top?.score ?? '-'}) | Bottom=${bottom?.id || '-'} ${bottom?.name || ''}(${bottom?.score ?? '-'})`
  ];
  if (pushEvent?.ts) {
    globalStatus.push(`- 最近推送：${new Date(pushEvent.ts).toLocaleString('zh-CN', { hour12: false })} · ${pushEvent.text || '-'}`);
  }

  const agentReviews = seats.map(seat => {
    const cf = Number(seat?.counterfactual?.decisionAlpha || 0);
    const win = Number(seat?.counterfactual?.winRate || 0) * 100;
    const signal = Number(seat?.decisionAlpha24h || 0);
    const upnl = Number(seat?.position?.unrealizedPnl || 0);
    const mode = String(seat?.executionMode || 'shadow').toUpperCase();

    const line = `${seat.id} ${seat.name}（${seat.role}｜${seat.state}｜${mode}）` +
      ` Score=${f2(seat.score)} | CF=${f2(cf, 6)} | Win=${f2(win, 1)}% | 信号=${f2(signal, 3)} | uPnL=${f2(upnl)}。${pickAgentComment(seat)}`;

    return {
      id: seat.id,
      name: seat.name,
      role: seat.role,
      state: seat.state,
      executionMode: mode,
      score: Number(f2(seat.score)),
      counterfactualDecisionAlpha: Number(f2(cf, 6)),
      winRatePct: Number(f2(win, 1)),
      signal: Number(f2(signal, 3)),
      unrealizedPnl: Number(f2(upnl)),
      comment: pickAgentComment(seat),
      line
    };
  });

  const issues = [];

  const topByCf = [...seats].sort((a, b) => Number(b?.counterfactual?.decisionAlpha || 0) - Number(a?.counterfactual?.decisionAlpha || 0))[0];
  if (topByCf && String(topByCf.executionMode || '').toLowerCase() === 'shadow') {
    issues.push(`- 执行席错配：${topByCf.id} (${topByCf.name}) 反事实优势最高但仍在 SHADOW，可关注晋升执行席。`);
  }

  const totalNotional = seats.reduce((acc, x) => acc + Math.abs(Number(x?.position?.notional || 0)), 0);
  const byInst = {};
  for (const x of seats) {
    const inst = x?.position?.instId || 'N/A';
    byInst[inst] = (byInst[inst] || 0) + Math.abs(Number(x?.position?.notional || 0));
  }
  const instTop = Object.entries(byInst).sort((a, b) => b[1] - a[1])[0];
  const concentration = totalNotional > 0 && instTop ? (instTop[1] / totalNotional) : 0;
  if (concentration >= 0.45 && instTop) {
    issues.push(`- 敞口集中：${instTop[0]} 名义占比约 ${f2(concentration * 100, 1)}%，建议限制单标的集中度。`);
  }

  if (warnCount >= 2) {
    issues.push(`- 状态退化：WARN 席位=${warnCount}，建议对低CF席位继续降权并收紧止损。`);
  }

  const lastOrderRun = execution?.lastOrderRun || {};
  const skipped = Number(lastOrderRun?.skipped || 0);
  if (Number(lastOrderRun?.total || 0) === 0 && skipped >= seats.length && seats.length > 0) {
    issues.push(`- 执行不足：最近一轮全部跳过（skipped=${skipped}），阈值/交易窗口可能偏严。`);
  }

  if (String(risk.level || '').toUpperCase() === 'YELLOW' || String(risk.level || '').toUpperCase() === 'RED') {
    issues.push(`- 风险档位=${risk.level}：${risk.action || '建议减仓并收紧止损'}。`);
  }

  if (!issues.length) {
    issues.push('- 暂无显著结构性异常。');
  }

  const lines = [];
  lines.push(`🦐虾系生态账户现状 ${new Date(state.generatedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push('');
  lines.push('【全局状态】');
  lines.push(...globalStatus);
  lines.push('');
  lines.push('【6个Agent逐个点评】');
  agentReviews.forEach((x, i) => lines.push(`${i + 1}) ${x.line}`));
  lines.push('');
  lines.push('【结构性问题】');
  lines.push(...issues);
  lines.push('');
  lines.push(`建议：${risk.action || '风控优先，轻仓执行'}`);
  lines.push('⚠️仅作研究与风险提示，不构成投资建议');

  let text = lines.join('\n');
  if (text.length > 3800) {
    text = `${text.slice(0, 3720)}\n...\n（内容过长已截断，完整版本请查看控制台“账户现状分析”）`;
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceStateTs: state.generatedAt || null,
    globalStatus,
    agentReviews,
    structuralIssues: issues,
    text
  };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
const cfg = loadConfig();
const analysis = buildAnalysis(state);

const payload = {
  ts: new Date().toISOString(),
  channel: cfg?.push?.channel || 'webchat',
  target: cfg?.push?.target || '',
  text: analysis.text,
  analysis,
  mode: 'shadow_only',
  cooldownMinutes: cfg?.push?.cooldown_minutes || 120
};

writeFileSync(join(OUTPUT_DIR, 'push-brief.txt'), analysis.text);
writeFileSync(join(OUTPUT_DIR, 'push-brief.json'), JSON.stringify(payload, null, 2));
console.log('✅ push payload generated:', join(OUTPUT_DIR, 'push-brief.json'));
