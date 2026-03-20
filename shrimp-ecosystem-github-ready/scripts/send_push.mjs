#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ROOT, ensureDirs, OUTPUT_DIR, loadConfig, loadState, saveState, addEvent, appendLedger
} from './lib/runtime.mjs';

const PUSH_QUEUE_PATH = join(ROOT, 'data', 'push_queue.json');
const dryRun = process.argv.includes('--dry-run');

function nowIso() {
  return new Date().toISOString();
}

function parseDotEnv(text = '') {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let val = (m[2] || '').trim();
    if (!val) {
      out[key] = '';
      continue;
    }

    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q)) {
      val = val.slice(1, -1);
    } else {
      const c = val.indexOf(' #');
      if (c >= 0) val = val.slice(0, c).trim();
    }

    out[key] = val;
  }
  return out;
}

function loadTokenFromEnvFiles() {
  const candidates = [
    join(ROOT, '.env'),
    join(ROOT, '..', '.env')
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseDotEnv(readFileSync(p, 'utf8'));
      if (parsed.SHRIMP_TELEGRAM_BOT_TOKEN) {
        return { token: parsed.SHRIMP_TELEGRAM_BOT_TOKEN, source: `${p}:SHRIMP_TELEGRAM_BOT_TOKEN` };
      }
      if (parsed.TELEGRAM_BOT_TOKEN) {
        return { token: parsed.TELEGRAM_BOT_TOKEN, source: `${p}:TELEGRAM_BOT_TOKEN` };
      }
    } catch {}
  }

  return { token: '', source: '' };
}

function parseJsonLoose(text = '') {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cand = lines.slice(i).join('\n').trim();
    if (!cand) continue;
    try { return JSON.parse(cand); } catch {}
  }
  return null;
}

function sendViaOpenClaw(chatId, text, opts = {}) {
  const args = [
    'message', 'send',
    '--channel', 'telegram',
    '--target', String(chatId),
    '--message', String(text),
    '--json'
  ];

  if (opts.dryRun) args.push('--dry-run');

  const timeoutMs = Math.max(8000, Number(opts.timeoutMs || 60000));
  const maxAttempts = Math.max(1, Math.min(8, Number(opts.maxAttempts || 5)));
  let last = null;

  for (let i = 1; i <= maxAttempts; i++) {
    const ret = spawnSync('openclaw', args, {
      encoding: 'utf8',
      timeout: timeoutMs
    });

    const stdout = String(ret.stdout || '').trim();
    const stderr = String(ret.stderr || '').trim();
    const parsed = parseJsonLoose(stdout);
    const ok = ret.status === 0 || parsed?.payload?.ok === true || parsed?.ok === true;

    if (ok) {
      return {
        ok: true,
        code: ret.status,
        stdout,
        stderr,
        parsed,
        attempt: i,
        attempts: i,
        messageId: parsed?.payload?.messageId || parsed?.payload?.message_id || null,
        detail: ''
      };
    }

    last = {
      ok: false,
      code: ret.status,
      stdout,
      stderr,
      parsed,
      attempt: i,
      attempts: maxAttempts,
      messageId: null,
      detail: stderr || stdout || 'openclaw-send-failed'
    };
  }

  return last || {
    ok: false,
    code: null,
    stdout: '',
    stderr: 'openclaw-send-unknown-error',
    parsed: null,
    attempt: 0,
    attempts: maxAttempts,
    messageId: null,
    detail: 'openclaw-send-unknown-error'
  };
}

async function sendViaTelegramApi(token, chatId, text, opts = {}) {
  const maxAttempts = Math.max(1, Math.min(6, Number(opts.maxAttempts || 3)));
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs || 30000));
  let lastErr = '';

  for (let i = 1; i <= maxAttempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('telegram-api-timeout')), timeoutMs);

    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true
        }),
        signal: ctl.signal
      });

      const body = await resp.json().catch(() => ({}));
      if (body?.ok) {
        clearTimeout(timer);
        return {
          ok: true,
          attempts: i,
          messageId: body?.result?.message_id || null,
          detail: ''
        };
      }

      lastErr = body?.description || `HTTP ${resp.status}`;
    } catch (e) {
      lastErr = String(e?.message || e || 'telegram-api-send-failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    messageId: null,
    detail: lastErr || 'telegram-api-send-failed'
  };
}

function loadQueue() {
  if (!existsSync(PUSH_QUEUE_PATH)) {
    return { version: 1, items: [] };
  }
  try {
    const q = JSON.parse(readFileSync(PUSH_QUEUE_PATH, 'utf8'));
    if (!q || typeof q !== 'object') return { version: 1, items: [] };
    if (!Array.isArray(q.items)) q.items = [];
    q.version = 1;
    return q;
  } catch {
    return { version: 1, items: [] };
  }
}

function saveQueue(queue) {
  writeFileSync(PUSH_QUEUE_PATH, JSON.stringify(queue, null, 2));
}

function queueCfg(cfg = {}) {
  return {
    maxRetries: Math.max(1, Number(cfg?.push?.max_retries || 8)),
    retryBaseSeconds: Math.max(5, Number(cfg?.push?.retry_base_seconds || 30)),
    retryMaxSeconds: Math.max(30, Number(cfg?.push?.retry_max_seconds || 1800)),
    maxItems: Math.max(50, Number(cfg?.push?.queue_max_items || 500))
  };
}

function dedupeKey(chatId, text, payload) {
  const explicit = String(payload?.idempotencyKey || payload?.idempotency_key || '').trim();
  if (explicit) return explicit;
  const h = createHash('sha1').update(`${chatId}|${text}`).digest('hex').slice(0, 24);
  return `tg_${h}`;
}

function pruneQueue(queue, maxItems) {
  const items = queue.items || [];
  if (items.length <= maxItems) return;

  const sent = items.filter(x => x.status === 'sent').sort((a, b) => Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0));
  let needDrop = items.length - maxItems;
  const dropSet = new Set();

  for (const it of sent) {
    if (needDrop <= 0) break;
    dropSet.add(it.id);
    needDrop -= 1;
  }

  if (needDrop > 0) {
    const failed = items.filter(x => x.status === 'failed').sort((a, b) => Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0));
    for (const it of failed) {
      if (needDrop <= 0) break;
      dropSet.add(it.id);
      needDrop -= 1;
    }
  }

  queue.items = items.filter(x => !dropSet.has(x.id));
}

function ensureEnqueued(queue, item, maxItems) {
  const existing = (queue.items || []).find(x => x.key === item.key);
  if (existing) return { item: existing, added: false };

  queue.items = queue.items || [];
  queue.items.push(item);
  pruneQueue(queue, maxItems);
  return { item, added: true };
}

function nextBackoffIso(item, cfg) {
  const attempt = Math.max(1, Number(item.attempts || 1));
  const secs = Math.min(cfg.retryMaxSeconds, cfg.retryBaseSeconds * (2 ** (attempt - 1)));
  return new Date(Date.now() + secs * 1000).toISOString();
}

function pickDueItem(queue, key, cfg) {
  const now = Date.now();
  const due = (queue.items || []).filter(x => {
    if (x.status === 'sent') return false;
    if (x.status === 'failed' && x.terminal) return false;
    if (Number(x.attempts || 0) >= cfg.maxRetries) return false;
    const next = Date.parse(x.nextRetryAt || 0);
    return !Number.isFinite(next) || next <= now;
  }).sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));

  const preferred = due.find(x => x.key === key);
  return preferred || due[0] || null;
}

ensureDirs();
const cfg = loadConfig();
const state = loadState();

if (!state) {
  console.error('state.json not found. Run: node scripts/run_task.mjs seed_state');
  process.exit(1);
}

if (!cfg?.push?.enabled) {
  console.log('push disabled in config, skip send_push');
  process.exit(0);
}

const channel = String(cfg?.push?.channel || 'telegram').toLowerCase();
if (channel !== 'telegram') {
  addEvent(state, { type: 'PUSH', level: 'WARN', text: `push channel=${channel} 暂不支持自动发送（仅支持 telegram）` });
  appendLedger('performance_ledger', {
    ts: nowIso(),
    type: 'PUSH_SEND',
    status: 'unsupported-channel',
    channel
  });
  saveState(state, { cfg });
  console.log(`skip send_push: unsupported channel ${channel}`);
  process.exit(0);
}

const payloadPath = join(OUTPUT_DIR, 'push-brief.json');
const payload = existsSync(payloadPath)
  ? JSON.parse(readFileSync(payloadPath, 'utf8'))
  : {
      target: cfg?.push?.target || '',
      text: `🦐虾系早报 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
    };

const chatId = String(payload.target || cfg?.push?.target || '').trim();
if (!chatId) {
  addEvent(state, { type: 'PUSH', level: 'RED', text: 'Telegram 推送失败（缺少 target chat_id）' });
  appendLedger('performance_ledger', {
    ts: nowIso(),
    type: 'PUSH_SEND',
    status: 'failed',
    reason: 'missing-target'
  });
  saveState(state, { cfg });
  console.error('missing push.target chat_id');
  process.exit(2);
}

const text = String(payload.text || '').trim();
if (!text) {
  console.error('empty push text');
  process.exit(1);
}

let tokenSource = '';
let token = process.env.SHRIMP_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
if (token) {
  tokenSource = process.env.SHRIMP_TELEGRAM_BOT_TOKEN ? 'process.env:SHRIMP_TELEGRAM_BOT_TOKEN' : 'process.env:TELEGRAM_BOT_TOKEN';
} else {
  const fallback = loadTokenFromEnvFiles();
  token = fallback.token || '';
  tokenSource = fallback.source || '';
}
const transport = token ? 'telegram-api-token' : 'openclaw-bound-channel';

if (dryRun) {
  if (!token) {
    const r = sendViaOpenClaw(chatId, text, { dryRun: true });
    if (!r.ok) {
      const detail = r.detail || r.stderr || r.stdout || 'openclaw-dryrun-failed';
      addEvent(state, { type: 'PUSH', level: 'RED', text: `Telegram 推送 dry-run 失败（${detail}）` });
      appendLedger('performance_ledger', {
        ts: nowIso(),
        type: 'PUSH_SEND',
        status: 'dryrun-failed',
        detail,
        transport
      });
      saveState(state, { cfg });
      console.error('telegram push dry-run failed:', detail);
      process.exit(2);
    }
  }

  addEvent(state, { type: 'PUSH', level: 'INFO', text: `Telegram 推送 dry-run 校验通过（chatId=${chatId}，未发送）` });
  appendLedger('performance_ledger', {
    ts: nowIso(),
    type: 'PUSH_SEND',
    status: 'dryrun',
    chatId,
    textChars: text.length,
    tokenSource,
    transport
  });
  saveState(state, { cfg });
  console.log('✅ telegram push dry-run ok', {
    chatId,
    textChars: text.length,
    tokenSource,
    transport
  });
  process.exit(0);
}

const qcfg = queueCfg(cfg);
const queue = loadQueue();
const key = dedupeKey(chatId, text, payload);

const existingSent = (queue.items || []).find(x => x.key === key && x.status === 'sent');
if (existingSent) {
  addEvent(state, { type: 'PUSH', level: 'INFO', text: `Telegram 推送去重命中，跳过重复发送（key=${key}）` });
  appendLedger('performance_ledger', {
    ts: nowIso(),
    type: 'PUSH_SEND',
    status: 'dedup-skip',
    key,
    chatId,
    transport,
    messageId: existingSent.messageId || null
  });
  saveState(state, { cfg });
  saveQueue(queue);
  console.log('skip send_push: deduplicated', { key, chatId, messageId: existingSent.messageId || null });
  process.exit(0);
}

const enqueueAt = nowIso();
const item = {
  id: `push_${Date.now()}_${randomBytes(3).toString('hex')}`,
  key,
  chatId,
  text,
  status: 'pending',
  attempts: 0,
  nextRetryAt: enqueueAt,
  createdAt: enqueueAt,
  updatedAt: enqueueAt,
  payloadPath,
  tokenSource,
  transport,
  messageId: null,
  lastError: ''
};

const enq = ensureEnqueued(queue, item, qcfg.maxItems);
saveQueue(queue);

const due = pickDueItem(queue, key, qcfg);
if (!due) {
  appendLedger('performance_ledger', {
    ts: nowIso(),
    type: 'PUSH_SEND',
    status: 'queued',
    key,
    chatId,
    transport
  });
  saveState(state, { cfg });
  console.log('push queued (no due item)', { key, chatId });
  process.exit(0);
}

let sendResult;
if (token) {
  sendResult = await sendViaTelegramApi(token, due.chatId, due.text, { maxAttempts: 3, timeoutMs: 30000 });
} else {
  sendResult = sendViaOpenClaw(due.chatId, due.text, { dryRun: false, maxAttempts: 5, timeoutMs: 60000 });
}

const ts = nowIso();
due.updatedAt = ts;
due.attempts = Number(due.attempts || 0) + Number(sendResult.attempts || 1);
due.transport = transport;
due.tokenSource = tokenSource;

if (sendResult.ok) {
  due.status = 'sent';
  due.sentAt = ts;
  due.messageId = sendResult.messageId || null;
  due.lastError = '';
  due.nextRetryAt = null;

  addEvent(state, { type: 'PUSH', level: 'INFO', text: `Telegram 推送成功（queueKey=${due.key}）` });
  appendLedger('performance_ledger', {
    ts,
    type: 'PUSH_SEND',
    status: 'success',
    key: due.key,
    chatId: due.chatId,
    messageId: due.messageId,
    tokenSource,
    transport,
    attempts: due.attempts,
    queued: enq.added
  });

  saveQueue(queue);
  saveState(state, { cfg });
  console.log('✅ telegram push sent', {
    key: due.key,
    chatId: due.chatId,
    messageId: due.messageId,
    transport,
    attempts: due.attempts,
    queued: enq.added
  });
  process.exit(0);
}

const detail = String(sendResult.detail || sendResult.stderr || sendResult.stdout || 'send-failed').trim();
due.lastError = detail;
const terminal = due.attempts >= qcfg.maxRetries;

if (terminal) {
  due.status = 'failed';
  due.terminal = true;
  due.nextRetryAt = null;
  addEvent(state, { type: 'PUSH', level: 'RED', text: `Telegram 推送失败且达到重试上限（queueKey=${due.key}）` });
  appendLedger('performance_ledger', {
    ts,
    type: 'PUSH_SEND',
    status: 'failed-terminal',
    key: due.key,
    chatId: due.chatId,
    detail,
    tokenSource,
    transport,
    attempts: due.attempts,
    maxRetries: qcfg.maxRetries
  });
  saveQueue(queue);
  saveState(state, { cfg });
  console.error('telegram send failed (terminal):', detail);
  process.exit(2);
}

due.status = 'pending';
due.terminal = false;
due.nextRetryAt = nextBackoffIso(due, qcfg);

addEvent(state, { type: 'PUSH', level: 'WARN', text: `Telegram 推送失败，已入队重试（queueKey=${due.key}）` });
appendLedger('performance_ledger', {
  ts,
  type: 'PUSH_SEND',
  status: 'retry-scheduled',
  key: due.key,
  chatId: due.chatId,
  detail,
  tokenSource,
  transport,
  attempts: due.attempts,
  nextRetryAt: due.nextRetryAt,
  maxRetries: qcfg.maxRetries
});

saveQueue(queue);
saveState(state, { cfg });
console.warn('telegram send failed, retry scheduled', {
  key: due.key,
  chatId: due.chatId,
  detail,
  nextRetryAt: due.nextRetryAt,
  attempts: due.attempts,
  maxRetries: qcfg.maxRetries
});
process.exit(0);
