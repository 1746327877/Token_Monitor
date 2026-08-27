// Command Goat Studio 会话:弹窗登录 commandcode.ai,抓取 Studio 顶部用量仪表 DOM。
// 会话 cookie 由持久化 partition('persist:commandcode-studio')保存;轮询用隐藏窗口 + 缓存。
const { BrowserWindow } = require('electron');
const { parseScrapedUsage, CRED_KEY } = require('./quota');
const { localDayStr } = require('../../core/locallog');

const STUDIO_URL = 'https://commandcode.ai/studio/';
const USAGE_URL = 'https://commandcode.ai/usage';
const PARTITION = 'persist:commandcode-studio';
const CACHE_MS = 3 * 60 * 1000;
const STATS_KEY = 'providers.command-goat.stats';

let cachedQuota = null;
let cachedAt = 0;

function windowOptions(extra) {
  return Object.assign({
    width: 1000,
    height: 720,
    show: true,
    center: true,
    title: '登录 Command Code Studio',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏轮询窗口必须关掉后台节流,否则 SPA 渲染/定时器被暂停,抓不到数据
      backgroundThrottling: false
    }
  }, extra || {});
}

function createSessionWindow() {
  return new BrowserWindow(windowOptions());
}

function readCred(store) {
  return (store && store.get(CRED_KEY)) || null;
}

function writeCred(store, cred) {
  if (store) store.set(CRED_KEY, cred);
}

// 每日 token 统计改用 opencode.db 里 command-code/commandcode 消息的精确按日数据:
// 用户在 opencode 里用 cmd 套餐,消息都在本地 DB,网页只显示四舍五入的月度总量(如 1.1B),
// 用它算增量会在单日增量不足以改变显示值时永远是 0。
function saveStats(store, items, tag) {
  if (!store) return;

  const opencodeLocallog = require('../opencode/locallog');
  const dbPath = (store.get('providers.opencode.dbPath')) || opencodeLocallog.DEFAULT_DB_PATH();
  const daily = opencodeLocallog.readCommandCodeDaily(dbPath);

  const usageDaily = store.get('usageDaily') || {};
  // 全量重算 command-goat 每日键(覆盖旧数据,避免舍入增量残留)
  Object.keys(usageDaily).forEach((k) => {
    if (k.indexOf('command-goat:') === 0) delete usageDaily[k];
  });
  let monthTokens = 0;
  let monthCost = 0;
  let monthRuns = 0;
  const monthPrefix = localDayStr(Date.now()).slice(0, 7);
  Object.keys(daily).forEach((date) => {
    const d = daily[date];
    usageDaily['command-goat:' + date] = {
      input: 0,
      cached: 0,
      output: d.total,
      total: d.total,
      cost: d.cost,
      messages: d.messages,
      models: []
    };
    if (date.indexOf(monthPrefix) === 0) {
      monthTokens += d.total;
      monthCost += d.cost;
      monthRuns += d.messages;
    }
  });
  store.set('usageDaily', usageDaily);
  // 使用卡片(本月 Token/费用/运行)也从本地精确数据取
  store.set(STATS_KEY, { tokens: monthTokens, cost: monthCost, runs: monthRuns });

  writeDebugDump(store, items, tag);
}

// 把抓取到的原始文本写入调试文件(usage/studio 分开),便于排查页面格式问题。
function writeDebugDump(store, items, tag) {
  try {
    const { app } = require('electron');
    const fs = require('fs');
    const path = require('path');
    const dir = app.getPath('userData');
    const file = path.join(dir, 'command-goat-debug-' + (tag || 'usage') + '.json');
    const payload = {
      at: new Date().toISOString(),
      items: items
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {}
}

// 读取最近一次抓取的使用统计(卡片展示)。
function getStats(ctx) {
  const store = ctx && ctx.store;
  const stats = (store && store.get(STATS_KEY)) || null;
  return stats || { tokens: 0, runs: 0, cost: 0 };
}

// 抓取用量仪表的内嵌脚本:按行扫描窗口标签(monthly/5-hour/Weekly),把标签后直到下一个窗口标签的
// 行拼成完整文本块(重置时间可能是独立行);再兜底扫含百分比+重置的叶子节点。
function scrapeUsageScript() {
  return '(() => {' +
    'var items = [];' +
    'var seen = {};' +
    'function add(text) {' +
    '  text = (text || "").trim();' +
    '  if (!text || seen[text] || text.length > 800) return;' +
    '  seen[text] = true;' +
    '  items.push(text);' +
    '}' +
    'var isMonthly = /monthly|month|月/i;' +
    'var is5h = /5-?hour|5\\s*小\\s*时/i;' +
    'var isWeekly = /weekly|本\\s*周/i;' +
    'var isTokens = /total\\s*tokens|tokens/i;' +
    'var isRuns = /total\\s*runs|runs/i;' +
    'var labelType = function (l) {' +
    '  if (is5h.test(l)) return "5h";' +
    '  if (isWeekly.test(l)) return "weekly";' +
    '  if (isMonthly.test(l)) return "monthly";' +
    '  return null;' +
    '};' +
    'var bodyText = document.body ? document.body.innerText : "";' +
    'var lines = bodyText.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);' +
    'for (var i = 0; i < lines.length; i++) {' +
    '  var t0 = labelType(lines[i]);' +
    '  if (!t0 && !isTokens.test(lines[i]) && !isRuns.test(lines[i])) continue;' +
    '  var block = lines[i];' +
    '  for (var j = i + 1; j < Math.min(lines.length, i + 15); j++) {' +
    '    var jt = labelType(lines[j]);' +
    '    if (jt && jt !== t0) break;' + // 只在遇到"不同类型"窗口标签时截断;同类续行(如 monthly 换行)继续拼接
    '    block += " " + lines[j];' +
    '  }' +
    '  add(block);' +
    '}' +
    'if (!items.length) {' +
    '  document.querySelectorAll("*").forEach(function (el) {' +
    '    if (el.children.length > 0) return;' +
    '    var t = (el.textContent || "").trim();' +
    '    if (t.length > 300) return;' +
    '    if (/\\d+(?:\\.\\d+)?\\s*%/.test(t) && /resets? in|重置|reset|\\d+\\s*[hdms]/.test(t)) {' +
    '      if (is5h.test(t) || isWeekly.test(t)) add(t);' +
    '    }' +
    '  });' +
    '}' +
    'return JSON.stringify({' +
    '  title: document.title || "",' +
    '  url: location.href,' +
    '  items: items.slice(0, 30),' +
    '  bodySample: bodyText.replace(/\\s+/g, " ").slice(0, 800)' +
    '});' +
    '})()';
}

async function scrapeUsage(win) {
  const text = await win.webContents.executeJavaScript(scrapeUsageScript());
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// 轮询等待仪表数据出现(登录后页面渲染需要时间)。
async function waitForUsage(win, timeoutMs) {
  const started = Date.now();
  let result = null;
  while (Date.now() - started < timeoutMs) {
    try {
      result = await scrapeUsage(win);
      if (result && result.items && result.items.length) return result;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return result;
}

// 登录捕获:可见窗口打开 Studio,用户登录后抓取用量仪表。成功 resolve QuotaState 并写 store。
function captureSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = (ctx && typeof ctx.createSessionWindow === 'function')
      ? ctx.createSessionWindow()
      : createSessionWindow();
    let settled = false;

    const finish = (quota) => {
      if (settled) return;
      settled = true;
      cachedQuota = quota;
      cachedAt = Date.now();
      writeCred(ctx && ctx.store, { capturedAt: Date.now() });
      try { win.close(); } catch (e) {}
      resolve(quota);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      logger.error('[command-goat] capture failed:', err && err.message ? err.message : err);
      try { win.close(); } catch (e) {}
      reject(err);
    };

    async function pollScrape() {
      // 1) usage 页:5小时/每周/每月窗口
      const result = await waitForUsage(win, 60000);
      if (settled) return;
      const quota = result ? parseScrapedUsage(result.items) : null;
      if (!quota) {
        logger.log('[command-goat] no usage meters found; page:', JSON.stringify(result));
        fail(new Error('未在用量页面找到额度数据(请确认已登录 GOAT 套餐)'));
        return;
      }
      logger.log('[command-goat] captured usage from DOM, windows:', quota.windows.map((w) => w.kind).join(','));
      saveStats(ctx && ctx.store, result.items, 'usage');
      // 2) studio 概览页:月度 tokens/runs 统计
      try {
        await win.loadURL(STUDIO_URL);
        const statsResult = await waitForUsage(win, 25000);
        if (statsResult && statsResult.items && statsResult.items.length) {
          saveStats(ctx && ctx.store, statsResult.items, 'studio');
        }
      } catch (e) {
        logger.log('[command-goat] stats page scrape failed:', e && e.message ? e.message : e);
      }
      finish(quota);
    }

    win.webContents.on('did-finish-load', () => {
      setTimeout(pollScrape, 3000);
    });
    win.webContents.on('did-navigate', (e, url) => {
      logger.log('[command-goat] navigate:', url);
    });
    win.webContents.on('did-stop-loading', async () => {
      try {
        const info = await win.webContents.executeJavaScript('JSON.stringify({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 300) })');
        logger.log('[command-goat] did-stop-loading:', info);
      } catch (err) {}
    });
    win.webContents.on('render-process-gone', (e, details) => {
      logger.log('[command-goat] render-process-gone:', JSON.stringify(details));
    });
    win.webContents.on('did-fail-load', (event, code, desc, url) => {
      logger.log('[command-goat] did-fail-load:', code, desc, url);
      if (code === -3) return;
      if (!settled) fail(new Error('登录窗口加载失败: ' + desc));
    });
    win.on('closed', () => {
      if (!settled) fail(new Error('未捕获到 Command Goat 用量数据(请登录后打开 Studio)'));
    });

    logger.log('[command-goat] capture session start ->', USAGE_URL);
    win.loadURL(USAGE_URL);
  });
}

// 轮询:3 分钟缓存 + 隐藏窗口抓取(usage 页取窗口,studio 页取统计)。
// 抓取失败时回退到最近一次成功缓存,绝不让卡片清空。
async function fetchQuota(ctx) {
  const store = ctx && ctx.store;
  const logger = (ctx && ctx.logger) || console;
  const cred = readCred(store);
  if (!cred) return null;
  const now = Date.now();
  if (cachedQuota && now - cachedAt < CACHE_MS) return cachedQuota;
  const win = new BrowserWindow(windowOptions({ show: false }));
  try {
    // 1) usage 页:5小时/每周/每月窗口
    await win.loadURL(USAGE_URL);
    const result = await waitForUsage(win, 25000);
    if (!result || !result.items || !result.items.length) {
      // 页面加载了但没有用量数据:可能是会话过期被重定向到登录页
      const url = result && result.url ? result.url : '';
      const title = result && result.title ? result.title : '';
      if (/signin|login|登录|sign in/i.test(url + ' ' + title)) {
        logger.log('[command-goat] session expired (redirected to login)');
        throw new Error('登录已过期，请重新登录');
      }
      logger.log('[command-goat] poll scrape empty; keeping cached quota');
      return cachedQuota;
    }
    // 统计保存与额度解析解耦:只要抓到页面就保存 tokens/每日增量,即使窗口解析失败
    saveStats(store, result.items, 'usage');
    const quota = parseScrapedUsage(result.items);
    if (!quota) {
      logger.log('[command-goat] poll scrape unparsable; keeping cached quota (stats saved)');
      return cachedQuota;
    }
    cachedQuota = quota;
    cachedAt = Date.now();
    // 2) studio 概览页:月度 tokens/runs 统计
    try {
      await win.loadURL(STUDIO_URL);
      const statsResult = await waitForUsage(win, 20000);
      if (statsResult && statsResult.items && statsResult.items.length) {
        saveStats(store, statsResult.items, 'studio');
      }
    } catch (e) {
      logger.log('[command-goat] stats page poll failed:', e && e.message ? e.message : e);
    }
    return quota;
  } catch (e) {
    logger.log('[command-goat] poll error:', e && e.message ? e.message : e, '; keeping cached quota');
    return cachedQuota;
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

module.exports = { captureSession, createSessionWindow, fetchQuota, readCred, writeCred, getStats, saveStats, scrapeUsageScript, STUDIO_URL, USAGE_URL, PARTITION, STATS_KEY };
