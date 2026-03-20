#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dataDir = join(root, 'data');
const outDir = join(root, 'output');
mkdirSync(outDir, { recursive: true });

const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));

const top = state.leaderboard.top[0];
const bottom = state.leaderboard.bottom[0];

const lines = [];
lines.push(`# 🦐 虾系生态投研早报（${new Date(state.generatedAt).toLocaleString('zh-CN', { hour12: false })}）`);
lines.push('');
lines.push('## 一、市场状态');
lines.push(`- 当前 Regime：${state.regime}`);
lines.push(`- 昨日生态总分变化：${state.ecosystemDelta}`);
lines.push(`- 建议手法：${state.regime === 'Range' ? '轻仓均值 + 避免追涨' : '顺势为主，严格止损'}`);
lines.push('');
lines.push('## 二、六席适应度播报');
lines.push(`- Top1：${top.id} ${top.name}（Score ${top.score}）`);
lines.push(`- Bottom1：${bottom.id} ${bottom.name}（Score ${bottom.score}）`);
lines.push('');
lines.push('## 三、反事实警报（DecisionAlpha）');
state.events.filter(e => e.type === 'CF').forEach(e => lines.push(`- ${e.text}`));
if (!state.events.some(e => e.type === 'CF')) lines.push('- 今日无异常反事实警报。');
lines.push('');
lines.push('## 四、A6 风险红警');
lines.push(`- A6触发次数（近30分钟）：${state.risk.a6Trigger30m}`);
lines.push(`- 风险级别：${state.risk.level}`);
lines.push(`- 建议：${state.risk.action}`);
lines.push('');
lines.push('> 免责声明：本报告仅作研究与风险提示，不构成投资建议。');

const outPath = join(outDir, 'daily-brief.md');
writeFileSync(outPath, lines.join('\n'));
console.log('✅ brief generated:', outPath);
