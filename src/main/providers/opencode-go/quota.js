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

// 归一化 lite.subscription.get 响应(纯函数)。兼容 { result } 包装与裸对象。
function parseQuota(data) {
  const result = data && (data.result || data);
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
  const data = await ctx.httpPostJson(cred.url, body, buildHeaders(cred), ctx.getProxyUrl());
  return parseQuota(data);
}

module.exports = { parseQuota, fetchQuota, buildHeaders, windowFromPercent, LIMITS, CRED_KEY };
