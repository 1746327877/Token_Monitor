// Command Goat 额度解析:GOAT 套餐 5小时/$14 + 每周/$35 两个滚动窗口(月度 $70 额度池)。
// 数据来自 Studio 网页渲染的用量仪表(百分比 + 重置时间),纯函数可测。
const { makeQuotaState } = require('../types');

const CRED_KEY = 'providers.command-goat.session';

// GOAT 套餐上限(usage-limits 文档):5 小时 $14 / 每周 $35。
const LIMITS = { rolling: 14, weekly: 35 };

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// 从文本解析百分比,如 "32%"。
function parsePercent(text) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''));
  return m ? clamp(parseFloat(m[1]), 0, 100) : null;
}

// 解析重置时间文本(zh/en):"3h 12m" / "2d 4h" / "3 小时 12 分钟" / "2 天 4 小时" → 秒。
function parseResetSeconds(text) {
  const s = String(text || '');
  if (/few second|几秒/i.test(s)) return 0;
  let total = 0;
  const re = /(\d+)\s*(天|小时|分钟|day|hour|minute|[dhms])/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.indexOf('天') !== -1 || unit === 'd' || unit.indexOf('day') === 0) total += n * 86400;
    else if (unit.indexOf('小') !== -1 || unit === 'h' || unit.indexOf('hour') === 0) total += n * 3600;
    else if (unit.indexOf('分') !== -1 || unit === 'm' || unit.indexOf('min') === 0) total += n * 60;
    else if (unit === 's') total += n;
  }
  return total;
}

// 把抓取到的文本块归一化为 QuotaState。
// 支持三种数据:
//   1) 月度额度池: "MONTHLY USAGE $0.12 of $70 used this month" → monthly 窗口(used/limit)
//   2) 5 小时窗口: "5-hour ███ 32% · resets in 3h 12m" → 5h 窗口
//   3) 每周窗口:   "Weekly ████ 41% · resets in 2d 4h"   → weekly 窗口
// items 支持字符串数组或 {label,text,value} 对象数组。
function parseScrapedUsage(items, now) {
  if (!Array.isArray(items) || !items.length) return null;
  const nowMs = now || Date.now();
  const windows = [];
  (items || []).forEach((item) => {
    const text = typeof item === 'string'
      ? item
      : String((item.label || '') + ' ' + (item.text || '') + ' ' + (item.value || ''));

    // 月度额度池: "$X of $Y used" + month/月 关键词
    const monthly = /\$\s*([\d.]+)\s*of\s*\$\s*([\d.]+)/i.exec(text);
    if (monthly && /month|月/i.test(text)) {
      const used = Math.max(0, parseFloat(monthly[1]) || 0);
      const limit = Math.max(0, parseFloat(monthly[2]) || 0);
      if (limit > 0) {
        windows.push({
          kind: 'monthly',
          name: '本月额度',
          used: used,
          limit: limit,
          remaining: Math.max(0, limit - used),
          resetsAt: null
        });
        return;
      }
    }

    const pct = parsePercent(text);
    if (pct === null) return;
    const resetSec = parseResetSeconds(text);
    let def = null;
    if (/5-?hour|5\s*小\s*时/i.test(text)) def = { kind: '5h', name: '5 小时窗口', limit: LIMITS.rolling };
    else if (/weekly|本\s*周/i.test(text)) def = { kind: 'weekly', name: '本周额度', limit: LIMITS.weekly };
    if (!def) return;
    const used = Math.round(def.limit * pct) / 100;
    windows.push({
      kind: def.kind,
      name: def.name,
      used: used,
      limit: def.limit,
      remaining: Math.max(0, def.limit - used),
      resetsAt: nowMs + resetSec * 1000
    });
  });
  if (!windows.length) return null;
  return makeQuotaState('command-goat', 'subscription', windows, null, 'Command Goat', null, nowMs);
}

module.exports = { parseScrapedUsage, parsePercent, parseResetSeconds, LIMITS, CRED_KEY };
