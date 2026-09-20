// OpenCode Go 额度采集:console(SolidStart)server function lite.subscription.get。
// 登录时捕获真实 _server 请求(体 + Cookie + URL),之后带 Cookie 轮询同一接口。
// 官方只返回百分比与重置倒计时,绝对值按套餐上限反推(见 LIMITS)。
const { makeQuotaState } = require('../types');

const CRED_KEY = 'providers.opencode-go.session';

// OpenCode Go 套餐上限(go.mdx):5 小时滚动 $12 / 每周 $30 / 每月 $60。
// 接口只回 usagePercent + resetInSec,used = limit * percent / 100。
const LIMITS = { rolling: 12, weekly: 30, monthly: 60 };

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function windowFromPercent(kind, name, percent, resetInSec, limit) {
  const pct = clamp(Number(percent) || 0, 0, 100);
  const used = Math.round(limit * pct) / 100;
  return {
    kind: kind,
    name: name,
    used: used,
    limit: limit,
    remaining: Math.max(0, limit - used),
    resetsAt: Date.now() + (Number(resetInSec) || 0) * 1000
  };
}

// 归一化 lite.subscription.get 响应(纯函数)。兼容常见 wrapper({ result }/{ data }/裸对象)。
function unwrap(data) {
  if (!data) return null;
  if (data && data.result) return data.result;
  if (data && data.data) return data.data;
  return data;
}

function parseQuota(data) {
  const result = unwrap(data);
  if (!result) return null;
  const windows = [];
  if (result.rollingUsage) {
    windows.push(windowFromPercent('5h', '5 小时窗口', result.rollingUsage.usagePercent, result.rollingUsage.resetInSec, LIMITS.rolling));
  }
  if (result.weeklyUsage) {
    windows.push(windowFromPercent('weekly', '本周额度', result.weeklyUsage.usagePercent, result.weeklyUsage.resetInSec, LIMITS.weekly));
  }
  if (result.monthlyUsage) {
    windows.push(windowFromPercent('monthly', '本月额度', result.monthlyUsage.usagePercent, result.monthlyUsage.resetInSec, LIMITS.monthly));
  }
  if (!windows.length) return null;
  return makeQuotaState('opencode-go', 'subscription', windows, null, 'OpenCode Go', null, Date.now());
}

// 重放时合并 Cookie 与捕获到的来源头(content-type/accept/origin/referer/UA 等)。
function buildHeaders(cred) {
  const headers = {};
  if (cred && cred.headers) {
    ['origin', 'referer', 'user-agent', 'accept', 'content-type'].forEach((k) => {
      if (cred.headers[k]) headers[k] = cred.headers[k];
    });
    Object.keys(cred.headers).forEach((k) => {
      if (/^x-/i.test(k)) headers[k] = cred.headers[k];
    });
  }
  if (cred && cred.cookie) headers['Cookie'] = cred.cookie;
  return headers;
}

// 轮询:带 Cookie 重放捕获到的 _server 请求。
async function fetchQuota(ctx) {
  const store = ctx && ctx.store;
  const cred = (store && store.get(CRED_KEY)) || null;
  if (!cred || !cred.url || !cred.cookie || !cred.requestBody) return null;
  let body;
  try { body = JSON.parse(cred.requestBody); } catch (e) { return null; }
  const post = (ctx && typeof ctx.httpPostJson === 'function')
    ? ctx.httpPostJson
    : require('../../core/http').httpPostJson;
  const data = await post(cred.url, body, buildHeaders(cred), ctx && ctx.getProxyUrl ? ctx.getProxyUrl() : null);
  return parseQuota(data);
}

// 新版 console 用量接口路径(2026-09 改版后,页面用量仪表由该接口渲染)。
// 注意带 /console 前缀:裸 /api/go/status 返回 404,控制台 base 下返回 401(需登录)。
const GO_STATUS_PATH = '/console/api/go/status';

module.exports = { parseQuota, fetchQuota, buildHeaders, windowFromPercent, LIMITS, CRED_KEY, parseScrapedUsage, parseResetSeconds, parseQuotaStatus, GO_STATUS_PATH };

// ============ DOM 抓取解析(SSR 直接把用量渲染进页面,无需 _server 请求) ============

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// 从 usage-value 文本解析百分比,如 "45%"。
function parsePercent(text) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''));
  return m ? clamp(parseFloat(m[1]), 0, 100) : null;
}

// 解析重置时间文本(zh/en):"2 小时 5 分钟"/"2 hours 5 minutes"/"几秒" → 秒。
function parseResetSeconds(text) {
  const s = String(text || '');
  if (/几秒|few second/i.test(s)) return 0;
  let total = 0;
  const re = /(\d+)\s*(天|小时|分钟|day|hour|minute)/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit.indexOf('天') !== -1 || /^d/i.test(unit)) total += n * 86400;
    else if (unit.indexOf('小') !== -1 || /^h/i.test(unit)) total += n * 3600;
    else if (unit.indexOf('分') !== -1 || /^m/i.test(unit)) total += n * 60;
  }
  return total;
}

// 按 DOM 顺序(rolling/weekly/monthly)把抓取到的 usage-item 归一化为 QuotaState。
function parseScrapedUsage(items, now) {
  if (!Array.isArray(items)) return null;
  const nowMs = now || Date.now();
  const defs = [
    { kind: '5h', name: '5 小时窗口', limit: LIMITS.rolling },
    { kind: 'weekly', name: '本周额度', limit: LIMITS.weekly },
    { kind: 'monthly', name: '本月额度', limit: LIMITS.monthly }
  ];
  const windows = [];
  for (let i = 0; i < defs.length; i++) {
    const item = items[i];
    if (!item) continue;
    const pct = parsePercent(item.value);
    if (pct === null) continue;
    const resetSec = parseResetSeconds(item.resetText);
    const used = Math.round(defs[i].limit * pct) / 100;
    windows.push({
      kind: defs[i].kind,
      name: defs[i].name,
      used: used,
      limit: defs[i].limit,
      remaining: Math.max(0, defs[i].limit - used),
      resetsAt: nowMs + resetSec * 1000
    });
  }
  if (!windows.length) return null;
  return makeQuotaState('opencode-go', 'subscription', windows, null, 'OpenCode Go', null, nowMs);
}

// ============ /api/go/status 解析(新版 console 用量接口,2026-09 改版后) ============
// 响应形如 { access, meters: { fiveHour, week, month }, endsAt },
// 每个 meter: { usedMicroCents, limitMicroCents, resetsAt }。
// 页面用同一接口渲染 "Go usage limits" 三个仪表;直接调接口比 DOM 抓取更稳。

// microCents(整数/数字字符串均可) → 美元,保留到分。
function toMicroDollars(v) {
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return 0;
    v = parseFloat(v);
  }
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  return Math.round(v / 10000) / 100;
}

// resetsAt/endsAt(ISO 字符串或 epoch 秒/毫秒) → ms 时间戳,解析失败返回 null。
function toResetMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  const t = Date.parse(String(v));
  return isNaN(t) ? null : t;
}

const STATUS_METER_DEFS = [
  { key: 'fiveHour', kind: '5h', name: '5 小时窗口' },
  { key: 'week', kind: 'weekly', name: '本周额度' },
  { key: 'month', kind: 'monthly', name: '本月额度' }
];

function parseQuotaStatus(data, now) {
  if (!data || typeof data !== 'object') return null;
  const root = data.data || data.result || data;
  if (!root || typeof root !== 'object') return null;
  const meters = root.meters;
  if (!meters || typeof meters !== 'object') return null;
  const nowMs = now || Date.now();
  const endsAt = toResetMs(root.endsAt);
  const windows = [];
  STATUS_METER_DEFS.forEach((def) => {
    const m = meters[def.key];
    if (!m || typeof m !== 'object') return;
    const limit = toMicroDollars(m.limitMicroCents);
    if (!(limit > 0)) return;
    const used = Math.min(Math.max(toMicroDollars(m.usedMicroCents), 0), limit);
    let resetsAt = toResetMs(m.resetsAt);
    // 月度仪表取订阅周期结束(与页面行为一致)
    if (resetsAt === null && def.kind === 'monthly') resetsAt = endsAt;
    windows.push({
      kind: def.kind,
      name: def.name,
      used: used,
      limit: limit,
      remaining: Math.max(0, Math.round((limit - used) * 100) / 100),
      resetsAt: resetsAt
    });
  });
  if (!windows.length) return null;
  return makeQuotaState('opencode-go', 'subscription', windows, null, 'OpenCode Go', null, nowMs);
}
