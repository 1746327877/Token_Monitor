// Command Goat Studio 会话:弹窗登录 commandcode.ai,抓取 Studio 顶部用量仪表 DOM。
// 会话 cookie 由持久化 partition('persist:commandcode-studio')保存;轮询用隐藏窗口 + 缓存。
const { BrowserWindow } = require('electron');
const { parseScrapedUsage, parseScrapedStats, CRED_KEY } = require('./quota');
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

function saveStats(store, items) {
  if (!store) return;
  const stats = parseScrapedStats(items);
  store.set(STATS_KEY, stats);
  // 把月度 token 总量计入"今天"的每日消耗(usageDaily),让每日 Token 消耗图/热力图显示 Command Goat。
  // Studio 只有月度总量,无每日明细,故按"本月累计"记在当天。
  const today = localDayStr(Date.now());
  const usageDaily = store.get('usageDaily') || {};
  usageDaily['command-goat:' + today] = {
    input: 0,
    cached: 0,
    output: stats.tokens,
    total: stats.tokens,
    cost: stats.cost,
    messages: stats.runs,
    models: []
  };
  store.set('usageDaily', usageDaily);
}

// 读取最近一次抓取的使用统计(卡片展示)。
function getStats(ctx) {
  const store = ctx && ctx.store;
  const stats = (store && store.get(STATS_KEY)) || null;
  return stats || { tokens: 0, runs: 0, cost: 0 };
}

// 抓取用量仪表的内嵌脚本:按行扫描窗口标签(monthly/5-hour/Weekly),把标签后几行拼成完整文本块;
// 再兜底扫含百分比+重置的叶子节点。附带页面标题/URL/正文片段用于诊断。
function scrapeUsageScript() {
  return '(() => {' +
    'var items = [];' +
    'var seen = {};' +
    'function add(text) {' +
    '  text = (text || "").trim();' +
    '  if (!text || seen[text] || text.length > 500) return;' +
    '  seen[text] = true;' +
    '  items.push(text);' +
    '}' +
    'var isMonthly = /monthly|month|月/i;' +
    'var is5h = /5-?hour|5\\s*小\\s*时/i;' +
    'var isWeekly = /weekly|本\\s*周/i;' +
    'var isTokens = /total\\s*tokens|tokens/i;' +
    'var isRuns = /total\\s*runs|runs/i;' +
    'var bodyText = document.body ? document.body.innerText : "";' +
    'var lines = bodyText.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);' +
    'for (var i = 0; i < lines.length; i++) {' +
    '  if (!isMonthly.test(lines[i]) && !is5h.test(lines[i]) && !isWeekly.test(lines[i]) && !isTokens.test(lines[i]) && !isRuns.test(lines[i])) continue;' +
    '  var block = lines[i];' +
    '  for (var j = i + 1; j < Math.min(lines.length, i + 5); j++) {' +
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
      saveStats(ctx && ctx.store, result.items);
      // 2) studio 概览页:月度 tokens/runs 统计
      try {
        await win.loadURL(STUDIO_URL);
        const statsResult = await waitForUsage(win, 25000);
        if (statsResult && statsResult.items && statsResult.items.length) {
          saveStats(ctx && ctx.store, statsResult.items);
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
      logger.log('[command-goat] poll scrape empty; keeping cached quota');
      return cachedQuota;
    }
    const quota = parseScrapedUsage(result.items);
    if (!quota) {
      logger.log('[command-goat] poll scrape unparsable; keeping cached quota');
      return cachedQuota;
    }
    cachedQuota = quota;
    cachedAt = Date.now();
    saveStats(store, result.items);
    // 2) studio 概览页:月度 tokens/runs 统计
    try {
      await win.loadURL(STUDIO_URL);
      const statsResult = await waitForUsage(win, 20000);
      if (statsResult && statsResult.items && statsResult.items.length) {
        saveStats(store, statsResult.items);
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
