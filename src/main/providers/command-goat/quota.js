// Command Goat 额度解析:GOAT 套餐 5小时/$14 + 每周/$35 两个滚动窗口(月度 $70 额度池)。
// 数据来自 Studio 网页渲染的用量仪表(百分比 + 重置时间),纯函数可测。
const { makeQuotaState } = require('../types');

const CRED_KEY = 'providers.command-goat.session';

// GOAT 套餐上限(usage-limits 文档):5 小时 $14 / 每周 $35 / 每月 $70。
const LIMITS = { rolling: 14, weekly: 35, monthly: 70 };

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// 从文本解析百分比,如 "32%"。
function parsePercent(text) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''));
  return m ? clamp(parseFloat(m[1]), 0, 100) : null;
}

// 解析重置时间文本 → 距现在的秒数。
// 支持:
//   相对时长: "3h 12m" / "2d 4h" / "3 小时 12 分钟" / "2 天 4 小时" / "few seconds"/"几秒"
//   绝对时刻: "resets at 3:00 PM" / "at 18:00" / "2026-08-18 18:00" / "今天 18:00"(距 now 换算秒数)
function parseResetSeconds(text, now) {
  const s = String(text || '');
  const nowMs = now || Date.now();
  if (/few second|几秒/i.test(s)) return 0;

  // 相对时长(优先,避免 "2h" 被绝对时间误读)
  let total = 0;
  let matchedDuration = false;
  const re = /(\d+)\s*(天|小时|分钟|day|hour|minute|[dhms])/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.indexOf('天') !== -1 || unit === 'd' || unit.indexOf('day') === 0) total += n * 86400;
    else if (unit.indexOf('小') !== -1 || unit === 'h' || unit.indexOf('hour') === 0) total += n * 3600;
    else if (unit.indexOf('分') !== -1 || unit === 'm' || unit.indexOf('min') === 0) total += n * 60;
    else if (unit === 's') total += n;
    matchedDuration = true;
  }
  if (matchedDuration && total > 0) return total;

  // 完整日期时间: 2026-08-18 18:00 / 2026-08-18T18:00
  const dt = /(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})/.exec(s);
  if (dt) {
    const target = new Date(
      parseInt(dt[1], 10), parseInt(dt[2], 10) - 1, parseInt(dt[3], 10),
      parseInt(dt[4], 10), parseInt(dt[5], 10), 0
    ).getTime();
    return Math.max(0, Math.round((target - nowMs) / 1000));
  }

  // 当天时刻: "3:00 PM" / "15:00" / "at 18:00" / "18:00"
  const hm = /(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/.exec(s);
  if (hm) {
    let hour = parseInt(hm[1], 10);
    const minute = parseInt(hm[2], 10);
    const ap = (hm[3] || '').toUpperCase();
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
    if (hour > 23) return 0;
    const target = new Date(nowMs);
    target.setHours(hour, minute, 0, 0);
    let diff = Math.round((target.getTime() - nowMs) / 1000);
    if (diff <= 0) diff += 24 * 3600; // 已过 → 明天同一时刻
    return diff;
  }

  return 0;
}

// 把抓取到的文本块归一化为 QuotaState。
// 支持三种数据:
//   1) 月度额度池: "MONTHLY USAGE $0.12 of $70 used this month" → monthly 窗口(used/limit)
//   2) 5 小时窗口: "5-hour ███ 32% · resets in 3h 12m" → 5h 窗口
//   3) 每周窗口:   "Weekly ████ 41% · resets in 2d 4h"   → weekly 窗口
// items 支持字符串数组或 {label,text,value} 对象数组。
// 页面里同一窗口可能被多次匹配(标签词出现多处),按 kind 去重:每种窗口只保留信息最全的一条,
// 并固定输出顺序 5小时 → 每周 → 每月。
function parseScrapedUsage(items, now) {
  if (!Array.isArray(items) || !items.length) return null;
  const nowMs = now || Date.now();
  const byKind = Object.create(null);

  function windowScore(w) {
    let s = 0;
    if (w.used > 0) s += 1;
    if (w.resetsAt) s += 1;
    if (w.limit > 0) s += 1;
    return s;
  }

  (items || []).forEach((item) => {
    const text = typeof item === 'string'
      ? item
      : String((item.label || '') + ' ' + (item.text || '') + ' ' + (item.value || ''));

    // 窗口类型(必须匹配到标签)
    let def = null;
    if (/5-?hour|5\s*小\s*时/i.test(text)) def = { kind: '5h', name: '5 小时窗口', limit: LIMITS.rolling };
    else if (/weekly|本\s*周/i.test(text)) def = { kind: 'weekly', name: '本周额度', limit: LIMITS.weekly };
    else if (/monthly|month|月/i.test(text)) def = { kind: 'monthly', name: '本月额度', limit: LIMITS.monthly };
    if (!def) return;

    let candidate = null;

    // 方式 A: "$X of $Y"(直接金额,5h/每周/月度池通用)
    const dollar = /\$\s*([\d.]+)\s*of\s*\$\s*([\d.]+)/i.exec(text);
    if (dollar) {
      const used = Math.max(0, parseFloat(dollar[1]) || 0);
      const limit = Math.max(0, parseFloat(dollar[2]) || 0);
      if (limit > 0) {
        candidate = {
          kind: def.kind,
          name: def.name,
          used: used,
          limit: limit,
          remaining: Math.max(0, limit - used),
          resetsAt: parseResetSeconds(text, nowMs) > 0 ? nowMs + parseResetSeconds(text, nowMs) * 1000 : null
        };
      }
    }

    // 方式 B: 百分比 "32%" + 重置时间(5h/每周),月度池用固定上限
    if (!candidate) {
      const pct = parsePercent(text);
      if (pct === null) return;
      const resetSec = parseResetSeconds(text, nowMs);
      const limit = def.limit !== undefined ? def.limit : LIMITS.monthly;
      const used = Math.round(limit * pct) / 100;
      candidate = {
        kind: def.kind,
        name: def.name,
        used: used,
        limit: limit,
        remaining: Math.max(0, limit - used),
        resetsAt: resetSec > 0 ? nowMs + resetSec * 1000 : null
      };
    }

    if (!candidate) return;
    const prev = byKind[candidate.kind];
    if (!prev || windowScore(candidate) > windowScore(prev)) {
      byKind[candidate.kind] = candidate;
    }
  });

  const windows = ['5h', 'weekly', 'monthly']
    .filter((k) => byKind[k])
    .map((k) => byKind[k]);
  if (!windows.length) return null;
  return makeQuotaState('command-goat', 'subscription', windows, null, 'Command Goat', null, nowMs);
}

// 从抓取文本提取月度使用统计:{ tokens, runs, cost }。
// 概览页: "TOTAL TOKENS 471.4K tokens" / "TOTAL RUNS 1 runs" / "MONTHLY USAGE $0.12 of $70 used this month"
function parseScrapedStats(items, now) {
  const text = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? item : String((item.label || '') + ' ' + (item.text || '') + ' ' + (item.value || ''))))
    .join(' ');

  const tokens = parseTokenCount(text);
  const runsMatch = /total\s+runs\s*(\d+)/i.exec(text);
  const monthly = /\$\s*([\d.]+)\s*of\s*\$\s*([\d.]+)/i.exec(text);

  return {
    tokens: tokens,
    runs: runsMatch ? parseInt(runsMatch[1], 10) : 0,
    cost: monthly ? Math.max(0, parseFloat(monthly[1]) || 0) : 0
  };
}

// 解析带单位 token 数:"471.4K" → 471400,"12.5M" → 12500000。
function parseTokenCount(text) {
  const m = /total\s+tokens\s*([\d.]+)\s*([KMBkmb])?/i.exec(text);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') return Math.round(n * 1000);
  if (unit === 'M') return Math.round(n * 1000000);
  if (unit === 'B') return Math.round(n * 1000000000);
  return Math.round(n);
}

module.exports = { parseScrapedUsage, parseScrapedStats, parsePercent, parseResetSeconds, parseTokenCount, LIMITS, CRED_KEY };
