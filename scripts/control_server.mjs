#!/usr/bin/env node
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, STATE_PATH, AGENTS_DIR,
  loadState, saveState, loadConfig, loadControl, saveControl, addEvent, loadBlacklist,
  applyKillSwitchBroadcast, armWrite, disarmWrite, getWriteArmState
} from './lib/runtime.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 9898);
const SERVER_STARTED_AT = new Date().toISOString();
const RUNTIME_HEALTH_PATH = join(ROOT, 'data', 'runtime_health.json');
const OKX_CMD_TIMEOUT_MS = Math.max(1200, Math.min(20_000, Number(process.env.OKX_CMD_TIMEOUT_MS || 3200)));
const OKX_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.OKX_RETRY_ATTEMPTS || 1)));
const OKX_PROFILE_SCAN_LIMIT = Math.max(1, Math.min(8, Number(process.env.OKX_PROFILE_SCAN_LIMIT || 4)));

function detectBuildHash() {
  try {
    const ret = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (ret.status === 0) return String(ret.stdout || '').trim() || 'unknown';
  } catch {}
  return 'unknown';
}

const SERVER_BUILD_HASH = detectBuildHash();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function serveFile(res, fp) {
  if (!existsSync(fp)) {
    json(res, 404, { ok: false, error: 'not-found' });
    return;
  }
  let real = fp;
  const st = statSync(fp);
  if (st.isDirectory()) {
    real = join(fp, 'index.html');
    if (!existsSync(real)) {
      json(res, 404, { ok: false, error: 'not-found' });
      return;
    }
  }
  const ext = extname(real);
  const type = mime[ext] || 'application/octet-stream';
  const buf = readFileSync(real);
  res.writeHead(200, { 'Content-Type': type });
  res.end(buf);
}

function safeJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readLastLines(path, n = 10) {
  if (!existsSync(path)) return '';
  const txt = readFileSync(path, 'utf8').trim();
  if (!txt) return '';
  return txt.split(/\r?\n/).slice(-n).join('\n');
}

function loadRuntimeHealth() {
  return safeJson(RUNTIME_HEALTH_PATH, {
    version: 1,
    runner: { buildHash: 'unknown', node: process.version, updatedAt: null },
    tasks: {},
    recent: []
  });
}

function collectKnowledge() {
  const out = { byAgent: {} };
  if (!existsSync(AGENTS_DIR)) return out;
  const ids = readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const id of ids) {
    const dir = join(AGENTS_DIR, id);
    const meta = safeJson(join(dir, 'meta.json'), null);
    const memoryPath = join(dir, 'memory.jsonl');
    const longTermPath = join(dir, 'long_term.md');

    let eventCount = 0;
    if (existsSync(memoryPath)) {
      const raw = readFileSync(memoryPath, 'utf8').trim();
      eventCount = raw ? raw.split(/\r?\n/).length : 0;
    }

    out.byAgent[id] = {
      id,
      meta,
      eventCount,
      lastSummary: readLastLines(longTermPath, 12)
    };
  }

  return out;
}

function runTask(task, args = []) {
  const ret = spawnSync(process.execPath, ['scripts/run_task.mjs', task, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: ret.status === 0,
    code: ret.status,
    stdout: (ret.stdout || '').trim(),
    stderr: (ret.stderr || '').trim()
  };
}

const okxCache = {
  profile: null,
  level: null,
  ts: 0,
  data: null,
  ttlMs: 20_000
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function firstNum(obj, keys, d = 0) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return d;
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function collectRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.rows)) return raw.rows;
  return [raw];
}

function normalizeBalance(raw) {
  const rows = collectRows(raw);
  const assets = [];
  let totalEq = 0;

  for (const row of rows) {
    totalEq = Math.max(totalEq, firstNum(row, ['totalEq', 'equity', 'eq'], 0));

    if (Array.isArray(row?.details) && row.details.length) {
      for (const d of row.details) {
        assets.push({
          ccy: d.ccy || d.currency || 'N/A',
          equity: firstNum(d, ['eq', 'equity', 'bal'], 0),
          available: firstNum(d, ['availEq', 'availBal', 'available'], 0),
          frozen: firstNum(d, ['frozenBal', 'frozen', 'ordFrozen'], 0),
          eqUsd: firstNum(d, ['eqUsd', 'usdVal', 'usd'], 0)
        });
      }
      continue;
    }

    if (row?.ccy || row?.currency) {
      assets.push({
        ccy: row.ccy || row.currency,
        equity: firstNum(row, ['eq', 'equity', 'bal'], 0),
        available: firstNum(row, ['availEq', 'availBal', 'available'], 0),
        frozen: firstNum(row, ['frozenBal', 'frozen', 'ordFrozen'], 0),
        eqUsd: firstNum(row, ['eqUsd', 'usdVal', 'usd'], 0)
      });
    }
  }

  const filtered = assets.filter(a => a.equity > 0 || a.available > 0 || a.frozen > 0);
  const fallbackEq = filtered.reduce((a, b) => a + b.equity, 0);
  const available = filtered.reduce((a, b) => a + b.available, 0);
  const frozen = filtered.reduce((a, b) => a + b.frozen, 0);

  return {
    totalEq: Number((totalEq || fallbackEq).toFixed(4)),
    available: Number(available.toFixed(4)),
    frozen: Number(frozen.toFixed(4)),
    assets: filtered.sort((a, b) => b.equity - a.equity).slice(0, 30)
  };
}

function normalizePositions(raw) {
  const rows = collectRows(raw);
  const out = [];

  for (const row of rows) {
    if (Array.isArray(row?.positions)) {
      for (const p of row.positions) out.push(p);
      continue;
    }
    out.push(row);
  }

  const normalized = out.map(p => {
    const qty = firstNum(p, ['pos', 'qty', 'sz', 'position'], 0);
    return {
      instId: p.instId || p.symbol || 'N/A',
      side: p.posSide || p.side || (qty >= 0 ? 'long' : 'short'),
      qty,
      avgPx: firstNum(p, ['avgPx', 'avgEntryPrice', 'entryPx'], 0),
      markPx: firstNum(p, ['markPx', 'last', 'lastPx'], 0),
      upl: firstNum(p, ['upl', 'unrealizedPnl', 'pnl'], 0),
      lever: firstNum(p, ['lever', 'leverage'], 0),
      mgnMode: p.mgnMode || p.marginMode || ''
    };
  }).filter(x => Math.abs(x.qty) > 0);

  return normalized.slice(0, 40);
}

function normalizePositionsHistory(raw, sinceMs) {
  const rows = collectRows(raw);
  const out = [];

  for (const row of rows) {
    if (Array.isArray(row?.positionsHistory)) {
      for (const p of row.positionsHistory) out.push(p);
      continue;
    }
    if (Array.isArray(row?.positions)) {
      for (const p of row.positions) out.push(p);
      continue;
    }
    out.push(row);
  }

  const toMs = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  };

  let realizedPnl24h = 0;
  let closedCount24h = 0;
  let lastCloseAtMs = 0;

  for (const p of out) {
    const ts = toMs(firstNum(p, ['uTime', 'ts', 'closeTime', 'cTime'], 0));
    const rp = firstNum(p, ['realizedPnl', 'pnl', 'closedPnl'], 0);
    if (ts >= sinceMs) {
      realizedPnl24h += rp;
      closedCount24h += 1;
      if (ts > lastCloseAtMs) lastCloseAtMs = ts;
    }
  }

  return {
    realizedPnl24h: Number(realizedPnl24h.toFixed(4)),
    closedCount24h,
    lastCloseAt: lastCloseAtMs ? new Date(lastCloseAtMs).toISOString() : null
  };
}

function runOkx(profile, args, opts = {}) {
  const timeoutMs = Math.max(1500, Number(opts.timeoutMs || OKX_CMD_TIMEOUT_MS));
  const ret = spawnSync('okx', ['--profile', profile, ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });

  const stderr = (ret.stderr || '').trim();
  const stdout = (ret.stdout || '').trim();
  const timedOut = ret?.error?.code === 'ETIMEDOUT' || /timed\s*out|timeout/i.test(stderr);

  return {
    ok: ret.status === 0,
    code: ret.status,
    stdout,
    stderr,
    timedOut,
    timeoutMs
  };
}

function isRetriableOkxErr(ret) {
  const msg = String(ret?.stderr || ret?.stdout || '').toLowerCase();
  return !!ret?.timedOut
    || msg.includes('failed to call okx endpoint')
    || msg.includes('network connectivity')
    || msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('econnreset')
    || msg.includes('socket hang up')
    || msg.includes('context deadline exceeded');
}

function runOkxWithRetry(profile, args, maxAttempts = OKX_RETRY_ATTEMPTS, opts = {}) {
  const n = Math.max(1, Math.min(3, Number(maxAttempts || 1)));
  let last = null;
  for (let i = 1; i <= n; i++) {
    const ret = runOkx(profile, args, opts);
    if (ret.ok) return { ...ret, attempts: i };
    last = ret;
    if (!isRetriableOkxErr(ret)) {
      return { ...ret, attempts: i };
    }
  }
  return { ...(last || { ok: false, code: 1, stdout: '', stderr: 'unknown error', timedOut: false }), attempts: n };
}

function discoverOkxProfiles() {
  const ret = spawnSync('okx', ['config', 'show'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1500, OKX_CMD_TIMEOUT_MS)
  });
  const txt = `${ret.stdout || ''}\n${ret.stderr || ''}`;
  const defaultProfile = (txt.match(/default_profile:\s*([^\s]+)/)?.[1] || '').trim();
  const profileNames = [...txt.matchAll(/^\[([^\]]+)\]$/gm)].map(m => m[1]);
  return {
    defaultProfile,
    profileNames
  };
}

function resolveOkxProfileCandidates(requested = 'demo') {
  const req = String(requested || 'demo').trim();
  if (req && req !== 'demo' && req !== 'live') {
    if (/^okx[-_]demo$/i.test(req)) {
      const cfg = discoverOkxProfiles();
      const set = new Set([req]);
      for (const p of cfg.profileNames) {
        if (/demo/i.test(p)) set.add(p);
      }
      return [...set].filter(Boolean).slice(0, OKX_PROFILE_SCAN_LIMIT);
    }
    return [req];
  }

  const mode = req === 'live' ? 'live' : 'demo';
  const cfg = discoverOkxProfiles();
  const set = new Set();

  if (cfg.defaultProfile) {
    const isDemo = /demo/i.test(cfg.defaultProfile);
    if ((mode === 'demo' && isDemo) || (mode === 'live' && !isDemo)) set.add(cfg.defaultProfile);
  }

  set.add(`okx-${mode}`);
  set.add(`okx_${mode}`);

  for (const p of cfg.profileNames) {
    const isDemo = /demo/i.test(p);
    if ((mode === 'demo' && isDemo) || (mode === 'live' && !isDemo)) set.add(p);
  }

  return [...set].filter(Boolean).slice(0, OKX_PROFILE_SCAN_LIMIT);
}

function fetchOkxAccount(profile = 'demo', force = false, level = 'fast') {
  const now = Date.now();
  const mode = String(level || 'fast').toLowerCase() === 'full' ? 'full' : 'fast';

  if (!force && okxCache.data && okxCache.profile === profile && okxCache.level === mode && (now - okxCache.ts) < okxCache.ttlMs) {
    return { ...okxCache.data, cached: true };
  }

  const candidates = resolveOkxProfileCandidates(profile);
  if (okxCache?.data?.profileResolved && !candidates.includes(okxCache.data.profileResolved)) {
    candidates.unshift(okxCache.data.profileResolved);
  }
  const retry = OKX_RETRY_ATTEMPTS;
  let resolvedProfile = null;
  let b = null;
  let lastErr = '';

  for (const c of candidates) {
    const ret = runOkxWithRetry(c, ['account', 'balance'], retry);
    if (ret.ok) {
      resolvedProfile = c;
      b = ret;
      break;
    }
    lastErr = ret.stderr || ret.stdout || lastErr;
  }

  if (!resolvedProfile || !b) {
    const msg = lastErr || 'okx balance command failed';
    if (okxCache.data && okxCache.profile === profile) {
      return {
        ...okxCache.data,
        ok: true,
        cached: true,
        stale: true,
        partial: true,
        warning: `OKX 读取超时，已回退缓存：${msg.slice(0, 120)}`
      };
    }

    return {
      ok: false,
      profile,
      triedProfiles: candidates,
      error: msg,
      hint: '请先配置 OKX API 凭据（okx config init），并确保对应 profile 可用。'
    };
  }

  const p = runOkxWithRetry(resolvedProfile, ['account', 'positions'], retry);
  const positionsError = p.ok ? null : (p.stderr || p.stdout || 'okx positions command failed');

  const fullMode = mode === 'full';
  const h = fullMode
    ? runOkxWithRetry(resolvedProfile, ['account', 'positions-history', '--limit', '200'], retry)
    : { ok: true, attempts: 0, stdout: '[]', stderr: '' };
  const historyError = fullMode && !h.ok ? (h.stderr || h.stdout || 'okx positions-history command failed') : null;

  const balance = normalizeBalance(parseJsonSafe(b.stdout));
  const positions = p.ok ? normalizePositions(parseJsonSafe(p.stdout)) : [];
  const upl = positions.reduce((a, x) => a + num(x.upl), 0);

  const prevSummary = (okxCache.data && okxCache.profile === profile)
    ? (okxCache.data.summary || {})
    : {};
  const h24 = fullMode
    ? (h.ok
      ? normalizePositionsHistory(parseJsonSafe(h.stdout), now - 24 * 3600 * 1000)
      : { realizedPnl24h: num(prevSummary.realizedPnl24h, 0), closedCount24h: num(prevSummary.closedCount24h, 0), lastCloseAt: prevSummary.lastCloseAt || null })
    : { realizedPnl24h: num(prevSummary.realizedPnl24h, 0), closedCount24h: num(prevSummary.closedCount24h, 0), lastCloseAt: prevSummary.lastCloseAt || null };

  const pnl24h = Number((h24.realizedPnl24h + upl).toFixed(4));

  const warnings = [];
  if ((b?.attempts || 1) > 1 || (p?.attempts || 1) > 1 || (h?.attempts || 1) > 1) {
    warnings.push(`网络抖动已自动重试（balance:${b?.attempts || 1}, positions:${p?.attempts || 1}, history:${h?.attempts || 1}）`);
  }
  if (positionsError) warnings.push('持仓读取失败，已仅展示余额。');
  if (historyError) warnings.push('24h已实现PnL读取失败，已使用缓存。');
  if (!fullMode) warnings.push('快速模式已跳过历史成交读取。');

  const payload = {
    ok: true,
    profile,
    profileResolved: resolvedProfile,
    level: mode,
    partial: warnings.length > 0,
    warning: warnings.join(' '),
    attempts: {
      balance: b?.attempts || 1,
      positions: p?.attempts || 1,
      history: h?.attempts || 0
    },
    positionsError,
    historyError,
    fetchedAt: new Date().toISOString(),
    summary: {
      equity: balance.totalEq,
      available: balance.available,
      frozen: balance.frozen,
      positionCount: positions.length,
      unrealizedPnl: Number(upl.toFixed(4)),
      realizedPnl24h: h24.realizedPnl24h,
      closedCount24h: h24.closedCount24h,
      pnl24h,
      lastCloseAt: h24.lastCloseAt
    },
    balances: balance.assets,
    positions
  };

  okxCache.profile = profile;
  okxCache.level = mode;
  okxCache.ts = now;
  okxCache.data = payload;
  return payload;
}

function warmRuntimeProjection() {
  try {
    const state = loadState();
    const control = loadControl();
    if (!state) return;
    const seats = state.seats || [];
    const withPos = seats.filter(s => !!s.position).length;
    const eqLen = (state.metrics?.accountEquitySeries || []).length;

    if (control.engineEnabled && seats.length > 0 && (withPos === 0 || eqLen === 0)) {
      const r = runTask('round_tick');
      if (!r.ok) {
        console.warn('warmRuntimeProjection failed:', r.stderr || r.stdout || r.code);
      } else {
        console.log('warmRuntimeProjection: round_tick applied');
      }
    }
  } catch (e) {
    console.warn('warmRuntimeProjection error:', e?.message || e);
  }
}

function applyControlCommand(cmd) {
  const control = loadControl();
  const state = loadState() || { events: [], mode: { shadow_only: true, demo_trade: false } };

  const log = (level, text) => {
    addEvent(state, { type: 'CONTROL', level, text });
    saveState(state);
  };

  if (cmd === 'start' || cmd === 'resume') {
    control.engineEnabled = true;
    saveControl(control);
    state.mode = control.mode;
    state.execution = state.execution || {};
    state.execution.orderWritePaused = false;
    state.execution.orderWritePausedUntil = null;
    state.risk = state.risk || {};
    state.risk.killSwitchActive = false;
    log('INFO', '手动开启：引擎已恢复运行（已清理 Kill Switch 写单冻结）');
    return { ok: true, message: 'engine started' };
  }

  if (cmd === 'stop' || cmd === 'pause') {
    const nextControl = disarmWrite({ ...control, engineEnabled: false, writeEnabled: false });
    saveControl(nextControl);
    state.mode = nextControl.mode;
    log('WARN', '手动关闭：引擎已暂停，并自动解除写单 Arm');
    return { ok: true, message: 'engine paused + write disarmed' };
  }

  if (cmd === 'shadow') {
    const nextControl = disarmWrite({
      ...control,
      mode: { shadow_only: true, demo_trade: false },
      writeEnabled: false
    });
    saveControl(nextControl);
    state.mode = nextControl.mode;
    log('INFO', '模式切换：shadow_only=true（已关闭写单）');
    return { ok: true, message: 'mode shadow_only' };
  }

  if (cmd === 'demo') {
    const cfg = loadConfig();

    const nextControl = armWrite({
      ...control,
      engineEnabled: true,
      mode: { shadow_only: false, demo_trade: true },
      okxProfile: 'okx-demo',
      writeEnabled: true
    }, cfg);
    saveControl(nextControl);

    state.mode = nextControl.mode;
    state.execution = state.execution || {};
    state.execution.orderWritePaused = false;
    state.execution.orderWritePausedUntil = null;
    state.risk = state.risk || {};
    state.risk.killSwitchActive = false;

    const armState = getWriteArmState(nextControl);
    log('WARN', `模式切换：demo_trade=true，写单授权改为运行时开关，自动 Arm 写单（有效至 ${armState.until || '-' }）`);

    return {
      ok: true,
      message: `mode demo_trade + runtime_write_enabled + armed until ${armState.until || '-'}`,
      writeEnabled: true,
      writeArmed: armState.armed,
      writeArmUntil: armState.until,
      writeArmActive: armState.active
    };
  }

  if (cmd === 'kill_switch') {
    const cfg = loadConfig();
    const ksCfg = cfg?.risk?.kill_switch || {};

    const nextControl = disarmWrite({
      ...control,
      engineEnabled: false,
      mode: { shadow_only: true, demo_trade: false },
      writeEnabled: false
    });
    saveControl(nextControl);
    state.mode = nextControl.mode;

    const ks = applyKillSwitchBroadcast(state, {
      execute: ksCfg.execute_actions !== false,
      allowLive: !!cfg?.execution?.allow_live_write,
      pauseMinutes: Number(ksCfg.cooldown_minutes || 60),
      maxCancelPerProfile: Number(ksCfg.max_cancel_orders || 20),
      maxClosePositions: Number(ksCfg.max_close_positions || 10)
    });

    state.risk = state.risk || {};
    state.risk.killSwitchActive = true;
    state.risk.killSwitchLastAt = new Date().toISOString();

    log('RED', `手动触发 Kill Switch：停引擎并回到 shadow_only（广播 ${ks?.profiles?.length || 0} 个执行账户）`);
    return { ok: true, message: 'kill switch engaged', killSwitch: ks };
  }

  if (cmd === 'arm_write') {
    const cfg = loadConfig();
    const ttlMin = Math.max(1, Math.min(24 * 60, Number(cfg?.execution?.arm_ttl_minutes || 120)));
    const nextControl = armWrite(control, cfg);
    saveControl(nextControl);
    const armState = getWriteArmState(nextControl);
    log('WARN', `手动开启写单 Arm（有效期 ${ttlMin} 分钟）`);
    return {
      ok: true,
      message: `write armed until ${armState.until}`,
      writeArmed: armState.armed,
      writeArmUntil: armState.until,
      writeArmActive: armState.active
    };
  }

  if (cmd === 'disarm_write') {
    const nextControl = disarmWrite(control);
    saveControl(nextControl);
    const armState = getWriteArmState(nextControl);
    log('INFO', '手动解除写单 Arm');
    return {
      ok: true,
      message: 'write disarmed',
      writeArmed: armState.armed,
      writeArmUntil: armState.until,
      writeArmActive: armState.active
    };
  }

  if (cmd === 'okx_demo') {
    control.okxProfile = 'okx-demo';
    saveControl(control);
    log('INFO', 'OKX 账户展示切换到 okx-demo');
    return { ok: true, message: 'okx profile set to okx-demo' };
  }

  if (cmd === 'okx_live') {
    control.okxProfile = 'live';
    saveControl(control);
    log('WARN', 'OKX 账户展示切换到 live（实盘只读）');
    return { ok: true, message: 'okx profile set to live' };
  }

  const taskMap = new Set(['round_tick', 'epoch_close', 'evolution_tick', 'weekly_report', 'copilot_brief', 'push_payload', 'send_push', 'send_push_dryrun', 'audit_replay', 'ab_runner', 'check_subaccounts', 'export_submission_bundle']);
  if (taskMap.has(cmd)) {
    const r = runTask(cmd);
    return { ok: r.ok, message: `${cmd} executed`, result: r };
  }

  return { ok: false, message: `unsupported command: ${cmd}` };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

warmRuntimeProjection();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/api/state' && req.method === 'GET') {
    const state = loadState();
    const control = { okxProfile: 'demo', ...loadControl() };
    const blacklist = loadBlacklist();
    const knowledge = collectKnowledge();
    const runtimeHealth = loadRuntimeHealth();
    const runnerBuild = String(runtimeHealth?.runner?.buildHash || 'unknown');
    const runtime = {
      server: {
        startedAt: SERVER_STARTED_AT,
        buildHash: SERVER_BUILD_HASH,
        pid: process.pid,
        node: process.version
      },
      runner: {
        buildHash: runnerBuild,
        updatedAt: runtimeHealth?.runner?.updatedAt || null,
        consistent: runnerBuild === 'unknown' || runnerBuild === SERVER_BUILD_HASH
      }
    };
    return json(res, 200, { ok: true, state, control, blacklist, knowledge, runtime, runtimeHealth });
  }

  if (u.pathname === '/api/okx/account' && req.method === 'GET') {
    const control = { okxProfile: 'demo', ...loadControl() };
    const qpRaw = (u.searchParams.get('profile') || '').trim();
    const qp = qpRaw.toLowerCase();
    const explicitProfile = !!qpRaw && qp !== 'live' && qp !== 'demo';
    const profile = explicitProfile
      ? qpRaw
      : ((qp === 'live' || qp === 'demo') ? qp : (control.okxProfile || 'demo'));
    const force = u.searchParams.get('force') === '1';
    const level = String(u.searchParams.get('level') || (force ? 'full' : 'fast')).toLowerCase() === 'full' ? 'full' : 'fast';

    if (!explicitProfile && (profile === 'live' || profile === 'demo') && profile !== control.okxProfile) {
      control.okxProfile = profile;
      saveControl(control);
    }

    const payload = fetchOkxAccount(profile, force, level);
    return json(res, payload.ok ? 200 : 500, payload);
  }

  if (u.pathname === '/api/command' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const cmd = String(body.command || '').trim();
      if (!cmd) return json(res, 400, { ok: false, error: 'command required' });
      const ret = applyControlCommand(cmd);
      return json(res, ret.ok ? 200 : 400, ret);
    } catch (e) {
      return json(res, 400, { ok: false, error: 'bad-json', detail: String(e.message || e) });
    }
  }

  if (u.pathname === '/' || u.pathname === '/dashboard') {
    res.writeHead(302, { Location: '/dashboard/' });
    return res.end();
  }

  const safePath = normalize(u.pathname).replace(/^\/+/, '');
  const fp = join(ROOT, safePath);
  if (!fp.startsWith(ROOT)) return json(res, 403, { ok: false, error: 'forbidden' });

  return serveFile(res, fp);
});

server.listen(PORT, HOST, () => {
  console.log(`🦐 control server running at http://${HOST}:${PORT}/dashboard/`);
});
