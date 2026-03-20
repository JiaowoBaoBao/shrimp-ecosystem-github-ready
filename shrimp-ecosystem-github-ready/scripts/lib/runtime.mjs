import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const DATA_DIR = join(ROOT, 'data');
export const OUTPUT_DIR = join(ROOT, 'output');
export const CONFIG_PATH = join(ROOT, 'config', 'shrimp.config.yaml');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const STATE_LOCK_PATH = join(DATA_DIR, '.state.lock');
export const CONTROL_PATH = join(DATA_DIR, 'control.json');
export const AGENTS_DIR = join(DATA_DIR, 'agents');
export const AGENT_ARCHIVE_DIR = join(DATA_DIR, 'agents_archive');
export const BLACKLIST_PATH = join(DATA_DIR, 'blacklist.json');

function defaultControlState() {
  return {
    engineEnabled: true,
    mode: { shadow_only: true, demo_trade: false },
    okxProfile: 'demo',
    writeEnabled: false,
    writeArmed: false,
    writeArmUntil: null,
    updatedAt: new Date().toISOString()
  };
}

export function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(AGENT_ARCHIVE_DIR, { recursive: true });
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

// Tiny YAML parser for this config shape (2-space indentation, scalars + nested maps + arrays)
export function loadConfig() {
  const txt = readFileSync(CONFIG_PATH, 'utf8');
  const lines = txt.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const cur = stack[stack.length - 1].obj;

    if (line.startsWith('- ')) {
      if (!Array.isArray(cur.__arr)) cur.__arr = [];
      cur.__arr.push(parseValue(line.slice(2).trim()));
      continue;
    }

    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();

    if (val === '') {
      cur[key] = {};
      stack.push({ indent, obj: cur[key] });
    } else {
      cur[key] = parseValue(val);
    }
  }

  function normalize(o) {
    if (!o || typeof o !== 'object') return o;
    if (o.__arr) return o.__arr.map(normalize);
    for (const k of Object.keys(o)) o[k] = normalize(o[k]);
    return o;
  }

  return normalize(root);
}

export function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function loadControl() {
  const fallback = defaultControlState();
  if (!existsSync(CONTROL_PATH)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_PATH, 'utf8'));
    return {
      ...fallback,
      ...parsed,
      mode: { ...fallback.mode, ...(parsed?.mode || {}) },
      writeEnabled: typeof parsed?.writeEnabled === 'boolean'
        ? parsed.writeEnabled
        : !!(parsed?.mode?.demo_trade && parsed?.writeArmed),
      writeArmed: !!parsed?.writeArmed,
      writeArmUntil: parsed?.writeArmUntil || null
    };
  } catch {
    return fallback;
  }
}

export function saveControl(control) {
  const next = {
    ...defaultControlState(),
    ...control,
    mode: {
      ...defaultControlState().mode,
      ...(control?.mode || {})
    },
    writeEnabled: typeof control?.writeEnabled === 'boolean' ? control.writeEnabled : defaultControlState().writeEnabled,
    writeArmed: !!control?.writeArmed,
    writeArmUntil: control?.writeArmUntil || null,
    updatedAt: new Date().toISOString()
  };
  writeFileSync(CONTROL_PATH, JSON.stringify(next, null, 2));
}

export function getWriteArmState(control = {}) {
  const armed = !!control?.writeArmed;
  const until = control?.writeArmUntil || null;
  const untilMs = until ? Date.parse(until) : NaN;
  const expired = armed && Number.isFinite(untilMs) && untilMs <= Date.now();
  const active = armed && (!Number.isFinite(untilMs) || untilMs > Date.now());
  return { armed, until, expired, active };
}

export function armWrite(control, cfg = {}) {
  const ttl = cfg?.execution?.arm_ttl_minutes || 120;
  const until = new Date(Date.now() + ttl * 60 * 1000).toISOString();
  return {
    ...control,
    writeArmed: true,
    writeArmUntil: until,
    updatedAt: new Date().toISOString()
  };
}

export function disarmWrite(control) {
  return {
    ...control,
    writeArmed: false,
    writeArmUntil: null,
    updatedAt: new Date().toISOString()
  };
}

export function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

export function agentDir(agentId) {
  return join(AGENTS_DIR, agentId);
}

export function ensureAgentMemory(agent) {
  const id = typeof agent === 'string' ? agent : agent.id;
  const name = typeof agent === 'string' ? agent : (agent.name || id);
  const role = typeof agent === 'string' ? '' : (agent.role || '');
  const dir = agentDir(id);
  mkdirSync(dir, { recursive: true });

  const metaPath = join(dir, 'meta.json');
  const memoryPath = join(dir, 'memory.jsonl');
  const longPath = join(dir, 'long_term.md');

  if (!existsSync(metaPath)) {
    saveJson(metaPath, {
      agentId: id,
      name,
      role,
      generation: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'ACTIVE'
    });
  }
  if (!existsSync(memoryPath)) writeFileSync(memoryPath, '');
  if (!existsSync(longPath)) writeFileSync(longPath, `# ${name} (${id}) 长期记忆\n\n`);
}

export function getAgentMeta(agentId) {
  const dir = agentDir(agentId);
  const metaPath = join(dir, 'meta.json');
  return loadJson(metaPath, {
    agentId,
    name: agentId,
    role: '',
    generation: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'ACTIVE'
  });
}

export function saveAgentMeta(agentId, meta) {
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  meta.updatedAt = new Date().toISOString();
  saveJson(join(dir, 'meta.json'), meta);
}

export function appendAgentMemory(agentId, entry) {
  ensureAgentMemory(agentId);
  const row = { ts: new Date().toISOString(), ...entry };
  appendFileSync(join(agentDir(agentId), 'memory.jsonl'), JSON.stringify(row) + '\n');
}

export function summarizeAgentMemory(agentId, opts = {}) {
  ensureAgentMemory(agentId);
  const keepRecent = opts.keepRecent ?? 180;
  const summarizeRecent = opts.summarizeRecent ?? 40;

  const memPath = join(agentDir(agentId), 'memory.jsonl');
  const longPath = join(agentDir(agentId), 'long_term.md');
  const meta = getAgentMeta(agentId);

  const raw = readFileSync(memPath, 'utf8').trim();
  const rows = raw ? raw.split('\n').map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) : [];

  if (!rows.length) return { summarized: false, kept: 0 };

  const recent = rows.slice(-summarizeRecent);
  const counts = {};
  for (const r of recent) {
    const k = r.type || 'OBS';
    counts[k] = (counts[k] || 0) + 1;
  }
  const topTypes = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `${k}:${v}`).join(', ');

  const latestScore = recent.findLast?.(x => x.score !== undefined)?.score ?? recent.slice().reverse().find(x => x.score !== undefined)?.score;
  const latestState = recent.findLast?.(x => x.state)?.state ?? recent.slice().reverse().find(x => x.state)?.state;

  const summary = [
    `## ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- generation: ${meta.generation}`,
    latestState ? `- latest_state: ${latestState}` : null,
    latestScore !== undefined ? `- latest_score: ${latestScore}` : null,
    `- recent_events: ${recent.length}`,
    `- event_types: ${topTypes || 'N/A'}`,
    ''
  ].filter(Boolean).join('\n');

  appendFileSync(longPath, summary + '\n');

  const kept = rows.slice(-keepRecent);
  writeFileSync(memPath, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  meta.lastSummarizedAt = new Date().toISOString();
  saveAgentMeta(agentId, meta);

  return { summarized: true, kept: kept.length, recent: recent.length };
}

export function ensureAllAgentMemories(state) {
  for (const s of (state?.seats || [])) {
    ensureAgentMemory(s);
    const meta = getAgentMeta(s.id);
    if (meta.name !== s.name || meta.role !== s.role) {
      meta.name = s.name;
      meta.role = s.role;
      saveAgentMeta(s.id, meta);
    }
  }
}

export function loadBlacklist() {
  return loadJson(BLACKLIST_PATH, { items: [] });
}

export function saveBlacklist(blacklist) {
  saveJson(BLACKLIST_PATH, blacklist);
}

export function blacklistAndArchiveAgent(agentId, reason, extra = {}) {
  ensureAgentMemory(agentId);
  const meta = getAgentMeta(agentId);
  meta.status = 'ELIMINATED';
  meta.eliminatedAt = new Date().toISOString();
  meta.eliminationReason = reason;
  saveAgentMeta(agentId, meta);

  appendAgentMemory(agentId, {
    type: 'ELIMINATION',
    reason,
    ...extra
  });

  summarizeAgentMemory(agentId, { keepRecent: 120, summarizeRecent: 60 });

  const blacklist = loadBlacklist();
  blacklist.items = blacklist.items || [];
  blacklist.items.unshift({
    ts: new Date().toISOString(),
    agentId,
    generation: meta.generation,
    reason,
    context: extra
  });
  blacklist.items = blacklist.items.slice(0, 300);
  saveBlacklist(blacklist);

  const src = agentDir(agentId);
  const dst = join(AGENT_ARCHIVE_DIR, `${agentId}-gen${meta.generation}-${Date.now()}`);
  if (existsSync(src)) renameSync(src, dst);

  return { archivedTo: dst, generation: meta.generation };
}

export function bootstrapNewAgentMemory(agent, parentId, reason = '') {
  ensureAgentMemory(agent);
  const meta = getAgentMeta(agent.id);
  const parentMeta = parentId ? getAgentMeta(parentId) : null;
  meta.generation = Math.max(1, (parentMeta?.generation || 0) + 1);
  meta.status = 'ACTIVE';
  meta.birthReason = reason || 'new-agent';
  saveAgentMeta(agent.id, meta);
  appendAgentMemory(agent.id, {
    type: 'BIRTH',
    parentId: parentId || null,
    generation: meta.generation,
    reason
  });
  return meta;
}

function readLedgerMeta(name) {
  const p = join(DATA_DIR, `${name}.ndjson`);
  if (!existsSync(p)) {
    return {
      exists: false,
      rows: 0,
      parseErrors: 0,
      latestTs: null,
      latestType: null
    };
  }

  const txt = readFileSync(p, 'utf8').trim();
  if (!txt) {
    return {
      exists: true,
      rows: 0,
      parseErrors: 0,
      latestTs: null,
      latestType: null
    };
  }

  let rows = 0;
  let parseErrors = 0;
  let latestTs = null;
  let latestType = null;

  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows += 1;
    try {
      const j = JSON.parse(line);
      if (j?.ts) latestTs = j.ts;
      if (j?.type) latestType = j.type;
    } catch {
      parseErrors += 1;
    }
  }

  return { exists: true, rows, parseErrors, latestTs, latestType };
}

export function replayAudit(state, cfg = {}) {
  const required = Array.isArray(cfg?.audit?.required_ledgers)
    ? cfg.audit.required_ledgers
    : ['decision_ledger', 'execution_ledger', 'evolution_ledger'];

  const ledgers = {};
  const issues = [];

  for (const name of required) {
    const meta = readLedgerMeta(name);
    ledgers[name] = meta;
    if (!meta.exists) issues.push(`${name}:missing`);
    if (meta.parseErrors > 0) issues.push(`${name}:parseErrors=${meta.parseErrors}`);
  }

  const missingRows = Object.values(ledgers).reduce((a, b) => a + (b.parseErrors || 0), 0);
  const status = issues.length ? 'FAIL' : 'PASS';

  return {
    status,
    missingRows,
    issues,
    ledgers,
    checkedAt: new Date().toISOString()
  };
}

function sleepMs(ms) {
  const i32 = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(i32, 0, 0, Math.max(1, ms));
}

function readCurrentStateRev() {
  if (!existsSync(STATE_PATH)) return 0;
  try {
    const cur = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return Math.max(0, Number(cur?._rev || 0));
  } catch {
    return 0;
  }
}

function withStateLock(fn, opts = {}) {
  const timeoutMs = Math.max(200, Number(opts.timeoutMs || 5000));
  const staleMs = Math.max(1000, Number(opts.staleMs || 120000));
  const pollMs = Math.max(10, Number(opts.pollMs || 40));
  const start = Date.now();

  while (true) {
    let fd = null;
    try {
      fd = openSync(STATE_LOCK_PATH, 'wx');
      try {
        return fn();
      } finally {
        try { if (fd !== null) closeSync(fd); } catch {}
        try { unlinkSync(STATE_LOCK_PATH); } catch {}
      }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;

      try {
        const st = statSync(STATE_LOCK_PATH);
        if (Date.now() - st.mtimeMs > staleMs) {
          unlinkSync(STATE_LOCK_PATH);
          continue;
        }
      } catch {}

      if (Date.now() - start > timeoutMs) {
        throw new Error(`state-lock-timeout:${timeoutMs}ms`);
      }
      sleepMs(pollMs);
    }
  }
}

export function saveState(state, opts = {}) {
  return withStateLock(() => {
    const currentRev = readCurrentStateRev();
    const prevRev = Math.max(0, Number(state?._rev || 0));

    if (opts?.allowStaleWrite === false && currentRev > prevRev) {
      throw new Error(`state-stale-write-detected: currentRev=${currentRev}, localRev=${prevRev}`);
    }

    state._rev = Math.max(currentRev, prevRev) + 1;
    state.generatedAt = new Date().toISOString();
    state.audit = state.audit || {};

    const cfgReplayOnSave = (opts.cfg?.audit?.replay_on_save) !== false;
    const replayEnabled = opts.replayAudit !== false && cfgReplayOnSave;
    const replay = replayEnabled ? replayAudit(state, opts.cfg || {}) : null;

    if (replay) {
      state.audit.replayStatus = replay.status;
      state.audit.missingRows = replay.missingRows;
      state.audit.replayIssues = replay.issues;
      state.audit.replayLedgers = replay.ledgers;
      state.audit.replayCheckedAt = replay.checkedAt;
    }

    state.audit.dailyRootHash = hashState(state);
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
  }, opts.lock || {});
}

export function hashState(state) {
  return crypto.createHash('sha256').update(JSON.stringify({
    generatedAt: state.generatedAt,
    seats: state.seats,
    account: state.account,
    risk: state.risk,
    metrics: state.metrics,
    execution: state.execution,
    champions: state.champions,
    semanticMutations: state.semanticMutations?.slice(0, 30),
    lineageHistory: state.lineageHistory?.slice(0, 100),
    events: state.events?.slice(0, 200)
  })).digest('hex');
}

export function appendLedger(name, row) {
  const p = join(DATA_DIR, `${name}.ndjson`);
  appendFileSync(p, JSON.stringify(row) + '\n');
}

export function addEvent(state, event) {
  state.events = state.events || [];
  state.events.unshift({ ts: new Date().toISOString(), ...event });
  state.events = state.events.slice(0, 200);
}

export function updateLeaderboard(state) {
  const sorted = [...state.seats].sort((a, b) => b.score - a.score);
  state.leaderboard = {
    top: sorted.slice(0, 3),
    bottom: [...sorted].reverse().slice(0, 2)
  };
  state.champions = computeChampions(state.seats);
}

function parseCsvList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, num(v, lo)));
}

export function normalizeSeatGene(seat = {}, defaults = {}) {
  const gene = seat?.gene || {};
  const base = {
    horizon: clamp(gene.horizon ?? defaults.horizon ?? 24, 1, 240),
    entry_th: clamp(gene.entry_th ?? defaults.entry_th ?? 0.1, 0.01, 2),
    exit_th: clamp(gene.exit_th ?? defaults.exit_th ?? 0.06, 0.005, 2),
    leverage: clamp(gene.leverage ?? seat?.position?.leverage ?? defaults.leverage ?? 1, 1, 20),
    sl: clamp(gene.sl ?? defaults.sl ?? 0.015, 0.001, 0.5),
    tp: clamp(gene.tp ?? defaults.tp ?? 0.03, 0.001, 1.5),
    turnover: clamp(gene.turnover ?? defaults.turnover ?? 0.3, 0.01, 5),
    regime_bias: String(gene.regime_bias ?? seat?.regimeFit ?? defaults.regime_bias ?? 'All')
  };

  return {
    ...base,
    prompt_gene_version: String(seat?.prompt_gene_version || gene?.prompt_gene_version || defaults.prompt_gene_version || 'v4.5-lite'),
    risk_profile: String(seat?.risk_profile || gene?.risk_profile || defaults.risk_profile || 'balanced'),
    agent_role_id: String(seat?.agent_role_id || gene?.agent_role_id || seat?.id || defaults.agent_role_id || 'UNKNOWN')
  };
}

function seatStateWeight(state = '') {
  if (state === 'ACTIVE') return 0.3;
  if (state === 'WARN') return -0.1;
  if (state === 'PIP') return -0.5;
  if (state === 'ELIMINATED') return -2;
  return 0;
}

function evalExecEligibility(seat = {}, state = {}, cfg = {}) {
  const gateEnabled = cfg?.execution?.evolution_exec_gate_enabled !== false;
  const gate = seat?.execGate || {};

  if (!gateEnabled || !gate?.required) {
    return {
      eligible: true,
      status: 'OPEN',
      reason: gateEnabled ? 'no-gate' : 'gate-disabled',
      shadowRounds: Number(gate?.shadowRounds || 0),
      minShadowRounds: Math.max(1, Number(cfg?.execution?.evolution_min_shadow_rounds || gate?.minShadowRounds || 6)),
      replayOk: true,
      requireReplayPass: false
    };
  }

  const minShadowRounds = Math.max(1, Number(gate?.minShadowRounds || cfg?.execution?.evolution_min_shadow_rounds || 6));
  const shadowRounds = Number(gate?.shadowRounds || 0);
  const requireReplayPass = gate?.requireReplayPass !== false && cfg?.execution?.evolution_require_replay_pass !== false;
  const createdAtMs = Date.parse(gate?.createdAt || 0);
  const replayStatus = String(state?.audit?.replayStatus || '').toUpperCase();
  const replayCheckedAtMs = Date.parse(state?.audit?.replayCheckedAt || 0);
  const replayOk = !requireReplayPass || (
    replayStatus === 'PASS' &&
    Number.isFinite(replayCheckedAtMs) &&
    (!Number.isFinite(createdAtMs) || replayCheckedAtMs >= createdAtMs)
  );

  const shadowOk = shadowRounds >= minShadowRounds;
  const eligible = shadowOk && replayOk;
  const reason = !shadowOk
    ? 'gate-shadow-rounds'
    : (!replayOk ? 'gate-replay-not-pass' : 'gate-ready');

  return {
    eligible,
    status: eligible ? 'READY' : 'PENDING',
    reason,
    shadowRounds,
    minShadowRounds,
    replayOk,
    requireReplayPass,
    replayStatus: replayStatus || 'UNKNOWN'
  };
}

export function rankAgentsForExecution(seats = []) {
  const ranked = seats.map(s => {
    const score = num(s.score);
    const da = num(s.decisionAlpha24h);
    const pnl = num(s.pnl24h);
    const composite = Number((score * 0.75 + da * 8 + pnl * 0.2 + seatStateWeight(s.state)).toFixed(4));
    return {
      id: s.id,
      name: s.name,
      role: s.role || '',
      state: s.state,
      score,
      decisionAlpha24h: da,
      pnl24h: pnl,
      composite
    };
  }).filter(x => x.state !== 'ELIMINATED')
    .sort((a, b) => b.composite - a.composite);

  return ranked.map((x, i) => ({ ...x, rank: i + 1 }));
}

function buildDesiredAssigned(ranking = [], slots = 5, maxAgentsPerRole = 2) {
  const maxCount = Math.max(1, Math.min(20, Number(maxAgentsPerRole || 2)));
  const desired = [];
  const seen = new Set();
  const roleCounts = {};
  const target = Math.min(slots, ranking.length);

  for (const row of ranking) {
    const roleKey = String(row.role || 'UNSPECIFIED').trim() || 'UNSPECIFIED';
    if ((roleCounts[roleKey] || 0) >= maxCount) continue;
    desired.push(row.id);
    seen.add(row.id);
    roleCounts[roleKey] = (roleCounts[roleKey] || 0) + 1;
    if (desired.length >= target) return desired;
  }

  for (const row of ranking) {
    if (seen.has(row.id)) continue;
    desired.push(row.id);
    seen.add(row.id);
    if (desired.length >= target) break;
  }

  return desired;
}

export function assignExecutionSlots(state, cfg = {}, opts = {}) {
  state.execution = state.execution || {};
  const policy = cfg?.execution?.policy || 'dynamic_top5';
  const slots = Math.max(1, Math.min(20, Number(cfg?.execution?.slots || 5)));
  const switchConfirmEpochs = Math.max(1, Math.min(10, Number(cfg?.execution?.switch_confirm_epochs || cfg?.execution?.switchConfirmEpochs || 2)));
  const maxAgentsPerRole = Math.max(1, Math.min(20, Number(cfg?.execution?.max_agents_per_role || 2)));
  const profiles = parseCsvList(cfg?.execution?.account_profiles || cfg?.execution?.accountProfiles);
  const epoch = Number(state?.hr?.epoch || 0);
  const roundStamp = String(state?.generatedAt || '');
  const force = !!opts.force;

  const hasRequiredExecGate = (state.seats || []).some(s => s?.execGate?.required);
  const shouldRecompute = force
    || !state.execution.ranking
    || !Array.isArray(state.execution.assignedAgentIds)
    || state.execution.updatedEpoch !== epoch
    || state.execution.updatedRoundStamp !== roundStamp
    || hasRequiredExecGate;

  if (!shouldRecompute) return state.execution;

  const byId = Object.fromEntries((state.seats || []).map(s => [s.id, s]));
  for (const s of (state.seats || [])) {
    const elig = evalExecEligibility(s, state, cfg);
    s.execEligibility = {
      ...elig,
      updatedAt: new Date().toISOString()
    };
    if (s.execGate && s.execGate.required) {
      s.execGate = {
        ...s.execGate,
        status: elig.status,
        reason: elig.reason,
        replayStatus: elig.replayOk ? 'pass' : (elig.requireReplayPass ? 'pending' : 'skip')
      };
    }
  }

  const ranking = rankAgentsForExecution(state.seats || []).map(r => ({
    ...r,
    eligible: byId[r.id]?.execEligibility?.eligible !== false,
    gateReason: byId[r.id]?.execEligibility?.reason || ''
  }));
  const rankingIds = ranking.map(x => x.id);
  const eligibleRanking = ranking.filter(x => x.eligible !== false);
  const eligibleIds = new Set(eligibleRanking.map(x => x.id));
  const rankIdx = Object.fromEntries(rankingIds.map((id, i) => [id, i]));

  const prevAssigned = Array.isArray(state.execution.assignedAgentIds) ? state.execution.assignedAgentIds : [];
  let currentAssigned = prevAssigned.filter(id => rankIdx[id] !== undefined && eligibleIds.has(id));

  if (currentAssigned.length === 0) {
    currentAssigned = buildDesiredAssigned(eligibleRanking, slots, maxAgentsPerRole);
  }

  const desiredAssigned = buildDesiredAssigned(eligibleRanking, slots, maxAgentsPerRole);
  const prevStreaks = state.execution.switchStreaks || {};
  const nextStreaks = {};
  const pendingSwitches = [];
  const appliedSwitches = [];

  if (policy === 'dynamic_top5') {
    const demoteCandidates = currentAssigned
      .filter(id => !desiredAssigned.includes(id))
      .sort((a, b) => (rankIdx[b] ?? 9999) - (rankIdx[a] ?? 9999));

    const promoteCandidates = desiredAssigned
      .filter(id => !currentAssigned.includes(id));

    const pairCount = Math.min(demoteCandidates.length, promoteCandidates.length);
    for (let i = 0; i < pairCount; i++) {
      const promoteId = promoteCandidates[i];
      const demoteId = demoteCandidates[i];
      const key = `${promoteId}->${demoteId}`;
      const streak = (prevStreaks[key] || 0) + 1;
      nextStreaks[key] = streak;

      const pending = {
        promoteId,
        demoteId,
        streak,
        required: switchConfirmEpochs
      };
      pendingSwitches.push(pending);

      if (streak >= switchConfirmEpochs) {
        currentAssigned = currentAssigned.filter(x => x !== demoteId);
        if (!currentAssigned.includes(promoteId)) currentAssigned.push(promoteId);
        appliedSwitches.push({ promoteId, demoteId, streak });
      }
    }
  }

  // 保证数量足够（例如淘汰或 gate 导致缺口）
  for (const id of eligibleRanking.map(x => x.id)) {
    if (currentAssigned.length >= slots) break;
    if (!currentAssigned.includes(id)) currentAssigned.push(id);
  }

  // 按排名顺序稳定输出
  currentAssigned = rankingIds.filter(id => eligibleIds.has(id) && currentAssigned.includes(id)).slice(0, slots);
  const assignedAgentIds = currentAssigned;
  const shadowAgentIds = rankingIds.filter(id => !assignedAgentIds.includes(id));

  for (const id of Object.keys(byId)) {
    byId[id].executionMode = assignedAgentIds.includes(id) ? 'exec' : 'shadow';
    byId[id].execProfile = null;
    byId[id].execRank = null;
  }

  const assigned = assignedAgentIds.map((id, i) => {
    const seat = byId[id];
    if (seat) {
      seat.executionMode = 'exec';
      seat.execRank = i + 1;
      seat.execProfile = profiles[i] || null;
    }
    const r = ranking.find(x => x.id === id);
    return {
      rank: i + 1,
      agentId: id,
      composite: r?.composite ?? null,
      profile: profiles[i] || null
    };
  });

  state.execution = {
    policy,
    slots,
    switchConfirmEpochs,
    maxAgentsPerRole,
    accountProfiles: profiles,
    updatedAt: new Date().toISOString(),
    updatedEpoch: epoch,
    updatedRoundStamp: roundStamp,
    ranking,
    eligibleCount: eligibleRanking.length,
    gatedCount: ranking.length - eligibleRanking.length,
    assignedAgentIds,
    shadowAgentIds,
    assigned,
    pendingSwitches,
    appliedSwitches,
    switchStreaks: nextStreaks,
    lastOrderPlan: state.execution.lastOrderPlan || null,
    lastOrderRun: state.execution.lastOrderRun || null,
    lastKillSwitch: state.execution.lastKillSwitch || null
  };

  return state.execution;
}

function mkOrderId(agentId, epoch, instId, side, qty) {
  const raw = `${agentId}|${epoch}|${instId}|${side}|${qty}`;
  const h = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `shp_${agentId}_${epoch}_${h}`.slice(0, 32);
}

function deriveExitPrices(instId, side, markPx, seat = {}, cfg = {}) {
  const gene = normalizeSeatGene(seat, { leverage: seat?.position?.leverage || 1 });
  const m = Math.max(0.0001, num(markPx, 0));
  const isDeriv = detectInstType(instId) !== 'spot';
  const longLike = String(side || '').toLowerCase() === 'buy' || String(side || '').toLowerCase() === 'long';
  const slPct = clamp(gene.sl, 0.001, 0.5);
  const tpPct = clamp(gene.tp, 0.001, 1.5);

  const slTriggerPx = longLike
    ? Number((m * (1 - slPct)).toFixed(4))
    : Number((m * (1 + slPct)).toFixed(4));
  const tpTriggerPx = longLike
    ? Number((m * (1 + tpPct)).toFixed(4))
    : Number((m * (1 - tpPct)).toFixed(4));

  return {
    enabled: isDeriv,
    slPct,
    tpPct,
    slTriggerPx,
    tpTriggerPx
  };
}

function checkHardGates({ seat = {}, state = {}, cfg = {}, instId = '', side = '', qty = 0, notionalUsd = 0, markPx = 0 }) {
  const out = { ok: true, hardViolation: false, reason: '', detail: null };
  const whitelist = parseCsvList(cfg?.execution?.instrument_whitelist || cfg?.runtime?.instruments || '');
  if (whitelist.length && !whitelist.includes(instId)) {
    return {
      ok: false,
      hardViolation: true,
      reason: 'hard-violation:inst-not-whitelisted',
      detail: { instId, whitelistSize: whitelist.length }
    };
  }

  const lev = num(seat?.position?.leverage, num(seat?.gene?.leverage, 1));
  const maxLeverage = Math.max(1, num(cfg?.risk?.max_leverage, 5));
  if (lev > maxLeverage) {
    return {
      ok: false,
      hardViolation: true,
      reason: 'hard-violation:leverage-exceed',
      detail: { leverage: lev, maxLeverage }
    };
  }

  if (isWritePaused(state)) {
    return {
      ok: false,
      hardViolation: true,
      reason: 'hard-violation:kill-switch-halt',
      detail: {
        pausedUntil: state?.execution?.orderWritePausedUntil || null
      }
    };
  }

  const requireStopLoss = cfg?.execution?.require_stop_loss !== false;
  const exits = deriveExitPrices(instId, side, markPx, seat, cfg);
  if (requireStopLoss && exits.enabled && !Number.isFinite(exits.slTriggerPx)) {
    return {
      ok: false,
      hardViolation: true,
      reason: 'hard-violation:missing-stop-loss',
      detail: { instId, side }
    };
  }

  const nav = Math.max(1, num(state?.account?.equity, 100000));
  const singleRiskPctNav = Math.max(0.05, num(cfg?.risk?.single_trade_risk_pct_nav, 0.5));
  const riskBudgetUsd = nav * (singleRiskPctNav / 100);
  const estimatedRiskUsd = Math.max(0, num(notionalUsd, 0)) * (exits.slPct || 0.01);
  if (estimatedRiskUsd > riskBudgetUsd) {
    return {
      ok: false,
      hardViolation: true,
      reason: 'hard-violation:single-trade-risk-exceed',
      detail: {
        estimatedRiskUsd: Number(estimatedRiskUsd.toFixed(4)),
        riskBudgetUsd: Number(riskBudgetUsd.toFixed(4)),
        singleRiskPctNav
      }
    };
  }

  out.detail = { exits, leverage: lev, notionalUsd: Number(notionalUsd.toFixed(4)), qty };
  return out;
}

export function buildExecutionOrderPlan(state, cfg = {}) {
  const regime = String(state?.regime || '').trim();
  const thresholdBase = num(cfg?.execution?.signal_threshold, 0.08);
  const thresholdByRegime = cfg?.execution?.signal_threshold_by_regime || cfg?.execution?.signalThresholdByRegime || {};
  const thresholdRegime = num(thresholdByRegime?.[regime], thresholdBase);
  const threshold = Math.max(0.01, Math.min(0.5, thresholdRegime));

  const qtyScaleBase = num(cfg?.execution?.qty_scale, 0.2);
  const qtyScaleByRegime = cfg?.execution?.qty_scale_by_regime || cfg?.execution?.qtyScaleByRegime || {};
  const qtyScaleRegime = num(qtyScaleByRegime?.[regime], qtyScaleBase);
  const qtyScale = Math.max(0.02, Math.min(1.0, qtyScaleRegime));

  const yellowQtyMultiplier = Math.max(0.05, Math.min(1.0, num(cfg?.execution?.yellow_qty_multiplier, 0.6)));
  const signalToEdgeBps = Math.max(100, Math.min(10000, num(cfg?.execution?.signal_to_edge_bps, 1000)));
  const minEdgeCostRatio = Math.max(0.2, Math.min(5, num(cfg?.execution?.min_edge_cost_ratio, 1.05)));
  const epoch = Number(state?.hr?.epoch || 0);
  const now = new Date().toISOString();
  const riskLevel = String(state?.risk?.level || 'GREEN').toUpperCase();
  const riskQtyMultiplier = riskLevel === 'YELLOW' ? yellowQtyMultiplier : riskLevel === 'RED' ? 0 : 1.0;

  const spreadMap = Object.fromEntries((state?.market?.tickers || []).map(t => [String(t.instId || ''), num(t.spreadBps, 0)]));
  const defaultSpreadBps = num(state?.market?.avgSpreadBps, 0);

  const assignedMap = Object.fromEntries((state?.execution?.assigned || []).map(x => [x.agentId, x.profile || null]));
  const orders = [];
  const skipped = [];

  for (const s of (state?.seats || [])) {
    if (s.executionMode !== 'exec') {
      skipped.push({ agentId: s.id, reason: 'not-exec' });
      continue;
    }

    const profile = assignedMap[s.id] || s.execProfile || null;
    if (!profile) {
      skipped.push({ agentId: s.id, reason: 'no-profile' });
      continue;
    }

    const signal = num(s.decisionAlpha24h);
    const fit = String(s?.regimeFit || 'All');
    const fitMultiplier = fit === 'All' || fit === regime ? 1 : 1.12;
    const seatThreshold = Number((threshold * fitMultiplier).toFixed(4));

    if (Math.abs(signal) < seatThreshold) {
      skipped.push({ agentId: s.id, reason: 'signal-below-threshold', signal, threshold: seatThreshold, regime, fit });
      continue;
    }

    if (riskLevel === 'RED') {
      skipped.push({ agentId: s.id, reason: 'risk-red-halt', signal });
      continue;
    }

    const instId = s.position?.instId || 'BTC-USDT';
    const instType = detectInstType(instId);
    const side = signal > 0 ? 'buy' : 'sell';
    const baseQty = Math.max(0.0001, num(s.position?.qty, 0.01));
    const markPx = Math.max(0.0001, num(s.position?.markPx, 0));
    const buyQuoteUsdt = Math.max(10, num(cfg?.execution?.market_buy_quote_usdt, 20));
    const sellBaseMin = Math.max(0.00001, num(cfg?.execution?.market_sell_min_base_qty, 0.0001));
    const scaledSellQty = Math.max(sellBaseMin, baseQty * qtyScale * riskQtyMultiplier);
    const scaledBuyQuote = Math.max(10, buyQuoteUsdt * riskQtyMultiplier);

    let qty;
    let qtyUnit;
    if (instType === 'spot') {
      // Spot market buy 在 OKX 常见为 quote 计量（USDT 金额）；sell 仍按 base 数量。
      qty = side === 'buy'
        ? Number(scaledBuyQuote.toFixed(4))
        : Number(scaledSellQty.toFixed(6));
      qtyUnit = side === 'buy' ? 'quote' : 'base';
    } else {
      // 衍生品统一使用 base/contract size（简化）
      qty = Number(scaledSellQty.toFixed(6));
      qtyUnit = 'base';
    }

    const notionalUsd = instType === 'spot'
      ? (side === 'buy' ? qty : Number((qty * markPx).toFixed(4)))
      : Number((qty * markPx).toFixed(4));

    const hardGate = checkHardGates({
      seat: s,
      state,
      cfg,
      instId,
      side,
      qty,
      notionalUsd,
      markPx
    });

    if (!hardGate.ok) {
      skipped.push({
        agentId: s.id,
        reason: hardGate.reason,
        hardViolation: !!hardGate.hardViolation,
        detail: hardGate.detail || null
      });
      continue;
    }

    const exits = hardGate.detail?.exits || deriveExitPrices(instId, side, markPx, s, cfg);
    const spreadBps = num(spreadMap[instId], defaultSpreadBps);
    const cost = estimateExecutionCost({ cfg, notionalUsd, spreadBps });
    const edgeBps = Math.abs(signal) * signalToEdgeBps;

    if (edgeBps < cost.totalCostBps * minEdgeCostRatio) {
      skipped.push({
        agentId: s.id,
        reason: 'cost-gate',
        signal: Number(signal.toFixed(4)),
        edgeBps: Number(edgeBps.toFixed(2)),
        totalCostBps: cost.totalCostBps,
        minEdgeCostRatio
      });
      continue;
    }

    const clOrdId = mkOrderId(s.id, epoch, instId, side, `${qtyUnit}:${qty}`);

    orders.push({
      ts: now,
      epoch,
      agentId: s.id,
      profile,
      instId,
      instType,
      side,
      ordType: 'market',
      qty,
      qtyUnit,
      mgnMode: String(cfg?.execution?.swap_mgn_mode || 'cross'),
      posSide: side === 'buy' ? 'long' : 'short',
      signal: Number(signal.toFixed(4)),
      riskLevel,
      riskQtyMultiplier,
      signalToEdgeBps,
      expectedEdgeBps: Number(edgeBps.toFixed(2)),
      spreadBps: Number(spreadBps.toFixed(2)),
      notionalUsd: Number(notionalUsd.toFixed(4)),
      exits,
      cost,
      hardGate,
      clOrdId
    });
  }

  const hardViolationCount = skipped.filter(x => x.hardViolation || String(x.reason || '').startsWith('hard-violation:')).length;

  return {
    ts: now,
    epoch,
    regime,
    threshold,
    thresholdBase: Number(thresholdBase.toFixed(4)),
    qtyScale,
    qtyScaleBase: Number(qtyScaleBase.toFixed(4)),
    riskLevel,
    riskQtyMultiplier,
    signalToEdgeBps,
    minEdgeCostRatio,
    hardViolationCount,
    orders,
    skipped
  };
}

function parseJsonLoose(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}

  // 有些 CLI 会输出前置 warning，尝试按行回溯 JSON。
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cand = lines.slice(i).join('\n').trim();
    if (!cand) continue;
    try { return JSON.parse(cand); } catch {}
  }
  return null;
}

function collectRowsLoose(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.rows)) return raw.rows;
  if (Array.isArray(raw.orders)) return raw.orders;
  if (Array.isArray(raw.positions)) return raw.positions;
  return [raw];
}

function runOkx(profile, args = [], opts = {}) {
  const full = ['--profile', profile, ...args];
  if (opts.json !== false && !full.includes('--json')) full.push('--json');

  const startedAtMs = Date.now();
  const ret = spawnSync('okx', full, {
    encoding: 'utf8',
    timeout: Math.max(2000, Number(opts.timeoutMs || 12000))
  });
  const durationMs = Math.max(0, Date.now() - startedAtMs);

  const stdout = String(ret.stdout || '').trim();
  const stderr = String(ret.stderr || '').trim();
  const parsed = parseJsonLoose(stdout);
  const timedOut = ret?.error?.code === 'ETIMEDOUT' || /timed\s*out|timeout/i.test(stderr);

  return {
    ok: ret.status === 0,
    code: ret.status,
    args: full,
    stdout,
    stderr,
    parsed,
    durationMs,
    timedOut
  };
}

function detectInstType(instId = '') {
  if (!instId) return 'spot';
  if (instId.includes('-SWAP')) return 'swap';
  if (/\-[0-9]{6}$/.test(instId)) return 'futures';
  return 'spot';
}

function isWritePaused(state) {
  const paused = !!state?.execution?.orderWritePaused;
  const until = Date.parse(state?.execution?.orderWritePausedUntil || 0);

  if (paused) {
    if (Number.isFinite(until)) return Date.now() < until;
    return true;
  }

  if (Number.isFinite(until) && Date.now() < until) return true;
  return false;
}

function parseHm(hm = '00:00') {
  const m = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + mm;
}

function inDemoExecWindow(cfg = {}) {
  const enabled = cfg?.execution?.demo_exec_window_enabled !== false;
  const raw = String(cfg?.execution?.demo_exec_window || '09:00-23:00');
  const [a, b] = raw.split('-').map(x => x.trim());
  const start = parseHm(a);
  const end = parseHm(b);
  if (!enabled || start === null || end === null) {
    return { enabled, active: true, window: raw, reason: enabled ? 'invalid-window' : 'disabled' };
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let active;
  if (start <= end) active = nowMin >= start && nowMin <= end;
  else active = nowMin >= start || nowMin <= end; // 跨天窗口

  return { enabled, active, window: raw, now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` };
}

function extractOrderAck(raw) {
  const rows = collectRowsLoose(raw);
  const row = rows[0] || raw || {};
  return {
    ordId: row.ordId || row.orderId || null,
    clOrdId: row.clOrdId || row.clientOrderId || null,
    state: row.state || row.status || null,
    fillSz: row.fillSz || row.filledSize || null,
    avgPx: row.avgPx || row.averagePrice || null,
    sCode: row.sCode || row.code || null,
    sMsg: row.sMsg || row.msg || null
  };
}

function placeOneOrder(order, cfg = {}, opts = {}) {
  const instType = detectInstType(order.instId);
  const enforceDemo = opts.enforceDemo !== false;
  const allowLiveWrite = !!cfg?.execution?.allow_live_write;

  if (enforceDemo && !allowLiveWrite && !/demo/i.test(order.profile || '')) {
    return {
      ...order,
      status: 'blocked',
      reason: 'live-profile-blocked-by-policy',
      attempts: 0,
      latencyMs: 0,
      timedOut: false,
      retryRecovered: false
    };
  }

  if (!['spot', 'swap', 'futures'].includes(instType)) {
    return {
      ...order,
      status: 'blocked',
      reason: `unsupported-inst-type:${instType}`,
      attempts: 0,
      latencyMs: 0,
      timedOut: false,
      retryRecovered: false
    };
  }

  const maxAttempts = Math.max(1, Math.min(3, Number(opts.writeRetries || cfg?.execution?.write_retry_attempts || 1)));
  let last = null;
  let totalLatencyMs = 0;

  for (let i = 1; i <= maxAttempts; i++) {
    const cmd = [];
    if (instType === 'spot') {
      cmd.push(
        'spot', 'place',
        '--instId', order.instId,
        '--side', order.side,
        '--ordType', order.ordType || 'market',
        '--sz', String(order.qty),
        '--clOrdId', order.clOrdId
      );
    } else {
      const product = instType === 'swap' ? 'swap' : 'futures';
      cmd.push(
        product, 'place',
        '--instId', order.instId,
        '--side', order.side,
        '--ordType', order.ordType || 'market',
        '--sz', String(order.qty),
        '--mgnMode', String(order.mgnMode || 'cross'),
        '--posSide', String(order.posSide || (order.side === 'buy' ? 'long' : 'short')),
        '--clOrdId', order.clOrdId
      );

      if (Number.isFinite(num(order?.exits?.tpTriggerPx, NaN))) {
        cmd.push('--tpTriggerPx', String(order.exits.tpTriggerPx));
        cmd.push('--tpOrdPx', '-1');
      }
      if (Number.isFinite(num(order?.exits?.slTriggerPx, NaN))) {
        cmd.push('--slTriggerPx', String(order.exits.slTriggerPx));
        cmd.push('--slOrdPx', '-1');
      }
    }

    const r = runOkx(order.profile, cmd, { json: true, timeoutMs: opts.timeoutMs || 15000 });
    totalLatencyMs += Number(r.durationMs || 0);

    const ack = extractOrderAck(r.parsed);
    if (r.ok && (ack.ordId || ack.clOrdId || ack.sCode === '0')) {
      return {
        ...order,
        status: 'accepted',
        attempts: i,
        latencyMs: totalLatencyMs,
        timedOut: false,
        retryRecovered: i > 1,
        ordId: ack.ordId,
        clOrdId: ack.clOrdId || order.clOrdId,
        state: ack.state || 'live',
        ack: {
          sCode: ack.sCode,
          sMsg: ack.sMsg,
          fillSz: ack.fillSz,
          avgPx: ack.avgPx
        }
      };
    }

    last = {
      ok: r.ok,
      code: r.code,
      stderr: (r.stderr || '').slice(0, 240),
      stdout: (r.stdout || '').slice(0, 240),
      timedOut: !!r.timedOut,
      durationMs: Number(r.durationMs || 0),
      ack
    };
  }

  return {
    ...order,
    status: 'rejected',
    attempts: maxAttempts,
    latencyMs: totalLatencyMs,
    timedOut: !!last?.timedOut,
    retryRecovered: false,
    reason: last?.stderr || last?.stdout || 'place-failed',
    ack: last?.ack || null
  };
}

export function executeOrderPlan(state, cfg = {}, opts = {}) {
  const plan = buildExecutionOrderPlan(state, cfg);
  const cfgWriteEnabled = !!cfg?.execution?.enable_order_write;
  const controlWriteEnabled = typeof opts?.control?.writeEnabled === 'boolean' ? opts.control.writeEnabled : null;
  const enableWrite = controlWriteEnabled === null ? cfgWriteEnabled : controlWriteEnabled;
  const allowWrite = enableWrite && !!opts.allowWrite;
  const armRequired = enableWrite && cfg?.execution?.require_manual_arm !== false;
  const armState = getWriteArmState(opts.control || {});
  const armActive = !armRequired || armState.active;
  const paused = isWritePaused(state);
  const demoWindow = inDemoExecWindow(cfg);
  const demoRoundCap = Math.max(1, Math.min(20, Number(cfg?.execution?.demo_max_orders_per_round || 2)));
  const demoTradeMode = !!state?.mode?.demo_trade;
  let demoWriteCount = 0;
  const receipts = [];

  for (const o of plan.orders) {
    if (!allowWrite) {
      receipts.push({
        ...o,
        status: 'dry-run',
        attempts: 0,
        latencyMs: 0,
        timedOut: false,
        retryRecovered: false,
        reason: enableWrite
          ? 'write-disabled-by-policy'
          : (controlWriteEnabled === null ? 'execution.enable_order_write=false' : 'control.writeEnabled=false')
      });
      continue;
    }

    if (demoTradeMode && demoWindow.enabled && !demoWindow.active) {
      receipts.push({
        ...o,
        status: 'dry-run',
        attempts: 0,
        latencyMs: 0,
        timedOut: false,
        retryRecovered: false,
        reason: `demo-window-closed:${demoWindow.window}`
      });
      continue;
    }

    if (demoTradeMode && demoWriteCount >= demoRoundCap) {
      receipts.push({
        ...o,
        status: 'dry-run',
        attempts: 0,
        latencyMs: 0,
        timedOut: false,
        retryRecovered: false,
        reason: `demo-round-cap:${demoRoundCap}`
      });
      continue;
    }

    if (armRequired && !armState.active) {
      receipts.push({
        ...o,
        status: 'dry-run',
        attempts: 0,
        latencyMs: 0,
        timedOut: false,
        retryRecovered: false,
        reason: 'manual-write-not-armed'
      });
      continue;
    }

    if (paused) {
      receipts.push({
        ...o,
        status: 'blocked',
        attempts: 0,
        latencyMs: 0,
        timedOut: false,
        retryRecovered: false,
        reason: 'order-write-paused-by-kill-switch'
      });
      continue;
    }

    const r = placeOneOrder(o, cfg, opts);
    receipts.push(r);
    if (demoTradeMode && (r.status === 'accepted' || r.status === 'rejected' || r.status === 'blocked')) {
      demoWriteCount += 1;
    }
  }

  const attemptedReceipts = receipts.filter(x => Number(x.attempts || 0) > 0);
  const latencySeries = attemptedReceipts.map(x => Number(x.latencyMs || 0)).filter(x => Number.isFinite(x) && x >= 0);
  const retriedReceipts = attemptedReceipts.filter(x => Number(x.attempts || 0) > 1);
  const retryRecoveredCount = attemptedReceipts.filter(x => x.status === 'accepted' && Number(x.attempts || 0) > 1).length;
  const timeoutCount = attemptedReceipts.filter(x => x.timedOut || /timeout|timed out/i.test(String(x.reason || ''))).length;
  const rejectedCount = attemptedReceipts.filter(x => x.status === 'rejected').length;

  const hardViolations = plan.hardViolationCount || plan.skipped.filter(x => x.hardViolation || String(x.reason || '').startsWith('hard-violation:')).length;

  const summary = {
    ts: plan.ts,
    epoch: plan.epoch,
    total: plan.orders.length,
    dryRun: receipts.filter(x => x.status === 'dry-run').length,
    accepted: receipts.filter(x => x.status === 'accepted').length,
    rejected: receipts.filter(x => x.status === 'rejected').length,
    blocked: receipts.filter(x => x.status === 'blocked').length,
    skipped: plan.skipped.length,
    hardViolations,
    enableWrite,
    writeEnableSource: controlWriteEnabled === null ? 'config' : 'control-runtime',
    writeActive: allowWrite,
    paused,
    armRequired,
    armActive,
    writeArmUntil: armState.until,
    demoWindow,
    demoRoundCap,
    demoWriteCount,
    riskLevel: plan.riskLevel,
    riskQtyMultiplier: plan.riskQtyMultiplier,
    estTotalCostUsd: Number(receipts.reduce((a, x) => a + num(x?.cost?.estCostUsd, 0), 0).toFixed(4)),
    placementOrders: attemptedReceipts.length,
    placementAttempts: attemptedReceipts.reduce((a, x) => a + Number(x.attempts || 0), 0),
    retries: attemptedReceipts.reduce((a, x) => a + Math.max(0, Number(x.attempts || 1) - 1), 0),
    rejectRate: attemptedReceipts.length ? Number((rejectedCount / attemptedReceipts.length).toFixed(4)) : 0,
    timeoutRate: attemptedReceipts.length ? Number((timeoutCount / attemptedReceipts.length).toFixed(4)) : 0,
    retryRecoveryRate: retriedReceipts.length ? Number((retryRecoveredCount / retriedReceipts.length).toFixed(4)) : 0,
    avgLatencyMs: latencySeries.length ? Number((latencySeries.reduce((a, b) => a + b, 0) / latencySeries.length).toFixed(1)) : 0,
    p95LatencyMs: latencySeries.length ? percentile(latencySeries, 95) : 0
  };

  state.execution = state.execution || {};
  state.execution.lastOrderPlan = plan;
  state.execution.lastOrderRun = {
    ...summary,
    receipts: receipts.slice(0, 60)
  };

  state.execution.healthSeries = state.execution.healthSeries || [];
  state.execution.healthSeries.push({
    ts: summary.ts,
    epoch: summary.epoch,
    rejectRate: summary.rejectRate,
    timeoutRate: summary.timeoutRate,
    retryRecoveryRate: summary.retryRecoveryRate,
    avgLatencyMs: summary.avgLatencyMs,
    p95LatencyMs: summary.p95LatencyMs,
    placementOrders: summary.placementOrders
  });
  state.execution.healthSeries = state.execution.healthSeries.slice(-80);

  return { plan, receipts, summary };
}

function pickLiveSpotOrders(raw) {
  const rows = collectRowsLoose(raw);
  return rows.filter(o => {
    const state = String(o.state || o.status || '').toLowerCase();
    if (!state) return true;
    return !['filled', 'canceled', 'cancelled'].includes(state);
  });
}

function closeDerivativePositions(profile, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const res = [];
  const p = runOkx(profile, ['account', 'positions'], { json: true, timeoutMs });
  if (!p.ok) {
    return [{ action: 'reduce_only_derisk', status: 'failed', reason: p.stderr || p.stdout || 'positions-read-failed' }];
  }

  const rows = collectRowsLoose(p.parsed);
  const active = rows.filter(x => Math.abs(Number(x.pos || x.qty || x.position || 0)) > 0);
  if (!active.length) {
    return [{ action: 'reduce_only_derisk', status: 'noop', reason: 'no-open-derivative-positions' }];
  }

  const maxClose = Math.max(1, Math.min(20, Number(opts.maxClosePositions || 10)));
  for (const pos of active.slice(0, maxClose)) {
    const instId = String(pos.instId || '');
    const instType = detectInstType(instId);
    if (!['swap', 'futures'].includes(instType)) {
      res.push({ action: 'reduce_only_derisk', status: 'skip', instId, reason: `unsupported-inst-type:${instType}` });
      continue;
    }

    const mgnMode = pos.mgnMode || pos.marginMode || 'cross';
    const posSide = pos.posSide || (Number(pos.pos || pos.qty || 0) >= 0 ? 'long' : 'short');
    const cmd = instType === 'swap' ? 'swap' : 'futures';
    const r = runOkx(profile, [cmd, 'close', '--instId', instId, '--mgnMode', String(mgnMode), '--posSide', String(posSide)], {
      json: true,
      timeoutMs
    });

    res.push({
      action: 'reduce_only_derisk',
      instId,
      posSide,
      mgnMode,
      status: r.ok ? 'sent' : 'failed',
      reason: r.ok ? '' : (r.stderr || r.stdout || 'close-failed').slice(0, 220)
    });
  }

  return res;
}

export function applyKillSwitchBroadcast(state, opts = {}) {
  const profiles = [...new Set((state?.execution?.assigned || []).map(x => x.profile).filter(Boolean))];
  const ts = new Date().toISOString();
  const sequence = ['stop_new_orders', 'cancel_open_orders', 'reduce_only_derisk'];
  const execute = !!opts.execute;
  const allowLive = !!opts.allowLive;
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs || 15000));
  const maxCancel = Math.max(1, Math.min(50, Number(opts.maxCancelPerProfile || 20)));

  state.execution = state.execution || {};
  state.execution.orderWritePaused = true;
  if (opts.pauseMinutes) {
    const until = new Date(Date.now() + Number(opts.pauseMinutes) * 60_000).toISOString();
    state.execution.orderWritePausedUntil = until;
  }

  const receipts = profiles.map(profile => {
    const profileReceipt = {
      profile,
      ts,
      sequence,
      execute,
      steps: []
    };

    if (!execute) {
      profileReceipt.status = 'simulated';
      profileReceipt.steps.push({ action: 'stop_new_orders', status: 'simulated' });
      profileReceipt.steps.push({ action: 'cancel_open_orders', status: 'simulated' });
      profileReceipt.steps.push({ action: 'reduce_only_derisk', status: 'simulated' });
      return profileReceipt;
    }

    if (!allowLive && !/demo/i.test(profile)) {
      profileReceipt.status = 'blocked';
      profileReceipt.steps.push({ action: 'stop_new_orders', status: 'ok' });
      profileReceipt.steps.push({ action: 'cancel_open_orders', status: 'blocked', reason: 'live-profile-blocked-by-policy' });
      profileReceipt.steps.push({ action: 'reduce_only_derisk', status: 'blocked', reason: 'live-profile-blocked-by-policy' });
      return profileReceipt;
    }

    profileReceipt.steps.push({ action: 'stop_new_orders', status: 'ok' });

    const openOrders = [];
    const openErrs = [];
    for (const product of ['spot', 'swap', 'futures']) {
      const openRes = runOkx(profile, [product, 'orders'], { json: true, timeoutMs });
      if (!openRes.ok) {
        openErrs.push(`${product}:${openRes.stderr || openRes.stdout || 'orders-read-failed'}`);
        continue;
      }
      const rows = pickLiveSpotOrders(openRes.parsed).map(r => ({ ...r, __product: product }));
      openOrders.push(...rows);
    }

    const targetOrders = openOrders.slice(0, maxCancel);
    const canceled = [];
    const failed = [];

    for (const o of targetOrders) {
      const product = String(o.__product || 'spot');
      const instId = o.instId || o.symbol;
      const ordId = o.ordId || o.orderId;
      if (!instId || !ordId) continue;
      const c = runOkx(profile, [product, 'cancel', '--instId', String(instId), '--ordId', String(ordId)], { json: true, timeoutMs });
      if (c.ok) canceled.push({ instId, ordId, product });
      else failed.push({ instId, ordId, product, reason: (c.stderr || c.stdout || 'cancel-failed').slice(0, 180) });
    }

    profileReceipt.steps.push({
      action: 'cancel_open_orders',
      status: (openErrs.length && !targetOrders.length) || failed.length ? 'partial' : 'ok',
      openOrders: targetOrders.length,
      canceled: canceled.length,
      readErrors: openErrs.slice(0, 3),
      failed: failed.slice(0, 10)
    });

    const derisk = closeDerivativePositions(profile, { timeoutMs, maxClosePositions: opts.maxClosePositions });
    profileReceipt.steps.push(...derisk);

    const hasFail = profileReceipt.steps.some(x => ['failed', 'blocked'].includes(x.status));
    profileReceipt.status = hasFail ? 'partial' : 'ok';
    return profileReceipt;
  });

  state.execution.lastKillSwitch = {
    ts,
    profiles,
    sequence,
    execute,
    receipts
  };

  return state.execution.lastKillSwitch;
}

export function computeChampions(seats) {
  const overall = [...seats].sort((a, b) => b.score - a.score)[0] || null;
  const pickBy = (fit) => {
    const pool = seats.filter(s => s.regimeFit === fit || s.regimeFit === 'All');
    if (!pool.length) return overall;
    return [...pool].sort((a, b) => b.score - a.score)[0];
  };
  return {
    overall,
    trend: pickBy('Trend'),
    range: pickBy('Range'),
    highVol: pickBy('High-Vol')
  };
}

export function addSemanticMutation(state, row) {
  state.semanticMutations = state.semanticMutations || [];
  const item = {
    ts: new Date().toISOString(),
    id: crypto.randomBytes(4).toString('hex'),
    ...row
  };
  state.semanticMutations.unshift(item);
  state.semanticMutations = state.semanticMutations.slice(0, 30);
  return item;
}

export function addLineageEvent(state, row) {
  state.lineageHistory = state.lineageHistory || [];
  const item = {
    ts: new Date().toISOString(),
    id: crypto.randomBytes(4).toString('hex'),
    ...row
  };
  state.lineageHistory.unshift(item);
  state.lineageHistory = state.lineageHistory.slice(0, 100);
  return item;
}

export function classifyRegime({ avgChangePct, avgRangePct }) {
  if (avgRangePct >= 4.0) return 'High-Vol';
  if (Math.abs(avgChangePct) >= 1.2) return 'Trend';
  return 'Range';
}

export function fetchTickersDetailed(instIds = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'], opts = {}) {
  const out = [];
  const failures = [];
  const maxAttempts = Math.max(1, Math.min(5, Number(opts.maxAttempts ?? 3)));

  for (const inst of instIds) {
    let ok = false;
    let lastErr = '';
    let used = 0;

    for (let i = 1; i <= maxAttempts; i++) {
      used = i;
      try {
        const raw = execSync(`okx market ticker ${inst} --json`, { encoding: 'utf8' });
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr[0]) {
          out.push(arr[0]);
          ok = true;
          break;
        }
        lastErr = 'empty ticker payload';
      } catch (e) {
        lastErr = String(e?.stderr || e?.stdout || e?.message || e || '').trim();
      }
    }

    if (!ok) {
      failures.push({
        instId: inst,
        attempts: used,
        error: lastErr.slice(0, 260)
      });
    }
  }

  return {
    tickers: out,
    failures,
    requested: instIds.length,
    success: out.length,
    failed: failures.length
  };
}

export function fetchTickers(instIds = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']) {
  return fetchTickersDetailed(instIds).tickers;
}

export function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function percentile(series = [], p = 95) {
  const vals = (series || []).map(x => num(x)).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!vals.length) return 0;
  const q = Math.max(0, Math.min(100, num(p, 95))) / 100;
  const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil(vals.length * q) - 1));
  return Number(vals[idx].toFixed(1));
}

export function estimateExecutionCost({ cfg = {}, notionalUsd = 0, spreadBps = 0 } = {}) {
  const feeBps = Math.max(0, Math.min(100, num(cfg?.execution?.fee_bps, 8)));
  const slippageBaseBps = Math.max(0, Math.min(100, num(cfg?.execution?.slippage_bps_base, 2)));
  const slippagePer10k = Math.max(0, Math.min(200, num(cfg?.execution?.slippage_bps_per_10k_usd, 1.2)));
  const depthRefUsd = Math.max(100, num(cfg?.execution?.depth_ref_usd, 10000));
  const notional = Math.max(0, num(notionalUsd, 0));
  const halfSpreadBps = Math.max(0, num(spreadBps, 0) / 2);
  const depthFactor = notional / depthRefUsd;
  const slippageBps = slippageBaseBps + depthFactor * slippagePer10k;
  const totalCostBps = feeBps + halfSpreadBps + slippageBps;
  const estCostUsd = notional * totalCostBps / 10000;
  return {
    feeBps: Number(feeBps.toFixed(2)),
    halfSpreadBps: Number(halfSpreadBps.toFixed(2)),
    slippageBps: Number(slippageBps.toFixed(2)),
    totalCostBps: Number(totalCostBps.toFixed(2)),
    estCostUsd: Number(estCostUsd.toFixed(4))
  };
}
