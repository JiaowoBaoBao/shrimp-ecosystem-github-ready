#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, OUTPUT_DIR, STATE_PATH, CONFIG_PATH } from './lib/runtime.mjs';

const outDir = join(OUTPUT_DIR, 'submission_bundle');
mkdirSync(outDir, { recursive: true });

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const cfg = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '';

const seats = state?.seats || [];
const execSeats = seats.filter(x => x.executionMode === 'exec');
const warningSeats = seats.filter(x => String(x.state || '').toUpperCase() === 'WARN');
const cfAvg = seats.length
  ? seats.reduce((a, x) => a + Number(x?.counterfactual?.decisionAlpha || 0), 0) / seats.length
  : 0;

const scorecard = `# 虾系生态进化场 - Hackathon Scorecard\n\n` +
`生成时间: ${new Date().toISOString()}\n\n` +
`## Integration (结合度)\n` +
`- 已打通链路：行情 -> 多Agent决策 -> 动态EXEC -> 风险闸门 -> 推送/审计\n` +
`- 当前执行席: ${execSeats.map(x => x.id).join(', ') || '-'}\n\n` +
`## Utility (实用性)\n` +
`- 账户权益: ${Number(state?.account?.equity || 0).toFixed(2)}\n` +
`- 风险等级: ${state?.risk?.level || '-'}\n` +
`- WARN席位: ${warningSeats.length}\n\n` +
`## Innovation (创新性)\n` +
`- 反事实评分均值 DecisionAlpha: ${cfAvg.toFixed(6)}\n` +
`- 动态Top5 + 进化门禁 + Kill Switch 已启用\n\n` +
`## Reproducibility (可复制性)\n` +
`- 配置文件: config.snapshot.yaml\n` +
`- 状态快照: state.snapshot.json\n` +
`- 复现脚本: reproduce.sh\n`;

const reproduce = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[1/4] seed state"
node scripts/run_task.mjs seed_state || true

echo "[2/4] run one round"
node scripts/run_task.mjs round_tick

echo "[3/4] build push payload"
node scripts/run_task.mjs push_payload

echo "[4/4] replay audit"
node scripts/run_task.mjs audit_replay

echo "Done. Open dashboard: http://127.0.0.1:9898/dashboard/"
`;

const manifest = {
  generatedAt: new Date().toISOString(),
  project: 'shrimp-ecosystem',
  stateGeneratedAt: state?.generatedAt || null,
  regime: state?.regime || null,
  riskLevel: state?.risk?.level || null,
  executionAssigned: (state?.execution?.assigned || []).map(x => x.agentId),
  files: ['config.snapshot.yaml', 'state.snapshot.json', 'scorecard.md', 'reproduce.sh']
};

writeFileSync(join(outDir, 'config.snapshot.yaml'), cfg || '# missing config\n');
writeFileSync(join(outDir, 'state.snapshot.json'), JSON.stringify(state, null, 2));
writeFileSync(join(outDir, 'scorecard.md'), scorecard);
writeFileSync(join(outDir, 'reproduce.sh'), reproduce, { mode: 0o755 });
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const readme = `# Submission Bundle\n\n` +
`本目录由 scripts/export_submission_bundle.mjs 自动生成。\n\n` +
`包含:\n` +
`- config.snapshot.yaml\n` +
`- state.snapshot.json\n` +
`- scorecard.md\n` +
`- reproduce.sh\n`;
writeFileSync(join(outDir, 'README.md'), readme);

console.log(`✅ submission bundle exported: ${outDir}`);
