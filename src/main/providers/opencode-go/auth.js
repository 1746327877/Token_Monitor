// OpenCode Go console 会话:弹窗登录 opencode.ai,SSR 会把用量直接渲染进 /go 页面。
// 因此登录/轮询都通过"加载页面 + 抓取 DOM(usage-item 的百分比与重置时间)"实现,
// 不再依赖拦截 _server 请求。会话 cookie 由持久化 partition('persist:opencode-console')保存。
const { BrowserWindow } = require('electron');
const { parseScrapedUsage, CRED_KEY } = require('./quota');

const CONSOLE_URL = 'https://opencode.ai/auth';
const PARTITION = 'persist:opencode-console';
const CACHE_MS = 5 * 60 * 1000;

let cachedQuota = null;
let cachedAt = 0;

function windowOptions(extra) {
  return Object.assign({
    width: 920,
    height: 700,
    show: true,
    center: true,
    title: '登录 OpenCode Go(console)',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏轮询窗口必须关掉后台节流,否则 SPA 渲染被暂停,抓不到数据
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

// 抓取页面内 usage-item 数据的内嵌脚本(SSR 渲染在 DOM 里)。
function scrapeUsageScript() {
  return '(() => {' +
    'var items = [];' +
    'document.querySelectorAll(\'[data-slot="usage-item"]\').forEach(function (el) {' +
    '  var label = el.querySelector(\'[data-slot="usage-label"]\');' +
    '  var value = el.querySelector(\'[data-slot="usage-value"]\');' +
    '  var reset = el.querySelector(\'[data-slot="reset-time"]\');' +
    '  items.push({ label: label ? label.textContent : "", value: value ? value.textContent : "", resetText: reset ? reset.textContent : "" });' +
    '});' +
    'return JSON.stringify(items);' +
    '})()';
}

async function scrapeUsage(win) {
  const text = await win.webContents.executeJavaScript(scrapeUsageScript());
  try {
    return JSON.parse(text);
  } catch (e) {
    return [];
  }
}

// 轮询等待 usage-item 出现(登录后 SPA/SSR 渲染需要时间)。
async function waitForUsage(win, timeoutMs) {
  const started = Date.now();
  let items = [];
  while (Date.now() - started < timeoutMs) {
    try {
      items = await scrapeUsage(win);
      if (items.length >= 3) return items;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return items;
}

function extractWorkspace(url) {
  const m = /\/workspace\/([^/?#]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

// 登录捕获:可见窗口打开 /auth → 用户 SSO 登录 → 自动跳 /workspace/<id>/go → 抓 DOM。
// 成功 resolve 归一化后的 QuotaState,并把 workspaceID 写入 store。
function captureSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = (ctx && typeof ctx.createSessionWindow === 'function')
      ? ctx.createSessionWindow()
      : createSessionWindow();
    let settled = false;
    let workspaceID = null;
    let navTimer = null;

    const finish = (quota) => {
      if (settled) return;
      settled = true;
      clearTimeout(navTimer);
      cachedQuota = quota;
      cachedAt = Date.now();
      const prev = readCred(ctx && ctx.store) || {};
      writeCred(ctx && ctx.store, Object.assign({}, prev, { workspaceID: workspaceID, capturedAt: Date.now() }));
      try { win.close(); } catch (e) {}
      resolve(quota);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(navTimer);
      logger.error('[opencode-go] capture failed:', err && err.message ? err.message : err);
      try { win.close(); } catch (e) {}
      reject(err);
    };

    // 已登录落地到 workspace 页后,自动跳到 Go 订阅页(保留语言前缀)
    win.webContents.on('did-navigate', (e, url) => {
      logger.log('[opencode-go] navigate:', url);
      workspaceID = workspaceID || extractWorkspace(url);
      const m = /(.*\/workspace\/[^/?#]+)/.exec(url);
      if (!m) return;
      let pathname;
      try { pathname = new URL(url).pathname; } catch (err) { return; }
      if (!/\/go(\/|$)/.test(pathname)) {
        logger.log('[opencode-go] goto go page:', m[1] + '/go');
        win.loadURL(m[1] + '/go');
      }
    });

    // 等 usage-item 渲染出来后抓取(最长 40s,覆盖登录时间)
    async function pollScrape() {
      const items = await waitForUsage(win, 40000);
      if (settled) return;
      const quota = parseScrapedUsage(items);
      if (!quota) {
        logger.log('[opencode-go] scraped items:', JSON.stringify(items));
        fail(new Error('未在订阅页找到用量数据(请确认登录并订阅了 OpenCode Go)'));
        return;
      }
      logger.log('[opencode-go] captured usage from DOM, windows:', quota.windows.map((w) => w.kind).join(','));
      finish(quota);
    }

    win.webContents.on('did-finish-load', () => {
      clearTimeout(navTimer);
      navTimer = setTimeout(pollScrape, 2500);
    });

    win.webContents.on('did-fail-load', (event, code, desc) => {
      logger.log('[opencode-go] did-fail-load:', code, desc);
      if (code === -3) return; // 导航被自身 loadURL 打断,忽略
      if (!settled) fail(new Error('登录窗口加载失败: ' + desc));
    });
    win.on('closed', () => {
      if (!settled) fail(new Error('未捕获到 OpenCode Go 用量数据(请登录并进入 Go 订阅页)'));
    });

    logger.log('[opencode-go] capture session start ->', CONSOLE_URL);
    win.loadURL(CONSOLE_URL);
  });
}

// 轮询:5 分钟缓存 + 隐藏窗口加载 /go 页并抓 DOM(会话在持久化 partition 里,无需手动 cookie)。
// 抓取失败时回退到最近一次成功缓存,绝不让卡片清空。
async function fetchQuota(ctx) {
  const store = ctx && ctx.store;
  const logger = (ctx && ctx.logger) || console;
  const cred = readCred(store);
  const workspaceID = cred && cred.workspaceID;
  if (!workspaceID) return null;
  const now = Date.now();
  if (cachedQuota && now - cachedAt < CACHE_MS) return cachedQuota;
  const win = new BrowserWindow(windowOptions({ show: false }));
  try {
    await win.loadURL('https://opencode.ai/workspace/' + workspaceID + '/go');
    const items = await waitForUsage(win, 25000);
    if (!items.length) {
      logger.log('[opencode-go] poll scrape empty; keeping cached quota');
      return cachedQuota;
    }
    const quota = parseScrapedUsage(items);
    if (quota) {
      cachedQuota = quota;
      cachedAt = Date.now();
      return quota;
    }
    logger.log('[opencode-go] poll scrape unparsable; keeping cached quota');
    return cachedQuota;
  } catch (e) {
    logger.log('[opencode-go] poll error:', e && e.message ? e.message : e, '; keeping cached quota');
    return cachedQuota;
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

module.exports = { captureSession, createSessionWindow, fetchQuota, readCred, writeCred, extractWorkspace, scrapeUsageScript, CONSOLE_URL, PARTITION };
