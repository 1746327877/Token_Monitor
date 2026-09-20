// OpenCode Go console 会话:弹窗登录 opencode.ai,进入 /console/<org>/go 后在页面上下文调
// /api/go/status 拿用量(2026-09 改版后用量仪表由该接口渲染,旧 data-slot DOM 已移除)。
// 会话 cookie 由持久化 partition('persist:opencode-console')保存。
const { BrowserWindow } = require('electron');
const { parseScrapedUsage, parseQuotaStatus, GO_STATUS_PATH, CRED_KEY } = require('./quota');

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
  // 兼容新旧两套 console 路由:旧 /workspace/<id>/...,新 /console/<orgId>/...(orgId 形如 org_*/wrk_*)。
  const m = /\/(?:workspace|console)\/([^/?#]+)/.exec(String(url || ''));
  if (!m) return null;
  if (/^(auth|login|signup)$/i.test(m[1])) return null;
  return m[1];
}

// 新版 Go 订阅页地址(2026-09 改版后,旧 /workspace/<id>/go 已失效)。
function goPageUrl(workspaceID) {
  return 'https://opencode.ai/console/' + workspaceID + '/go';
}

function isGoPath(pathname) {
  return /\/go(\/|$)/.test(String(pathname || ''));
}

function isAuthPath(pathname) {
  return /\/(auth|login|signup)($|\/|\?)/.test(String(pathname || ''));
}

// 在页面上下文里调同源 /console/api/go/status(自动带 partition 的登录 cookie),
// 比 DOM 抓取更稳:新版页面用量仪表直接由该接口渲染。
// 必须带 x-org-id 头(路由里的 org/wrk id),否则接口回 400 BadRequest。
function apiStatusScript(orgId) {
  return '(() => fetch(' + JSON.stringify(GO_STATUS_PATH) +
    ', { headers: { accept: "application/json", "x-org-id": ' + JSON.stringify(String(orgId || '')) +
    ' }, credentials: "same-origin" })' +
    '.then(async (r) => ({ status: r.status, body: await r.text() }))' +
    '.catch((e) => ({ error: String((e && e.message) || e) })))()';
}

async function fetchStatusJson(win, orgId) {
  let raw = null;
  try {
    raw = await win.webContents.executeJavaScript(apiStatusScript(orgId));
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  if (!raw || typeof raw !== 'object') return { error: 'empty response' };
  if (raw.error) return { error: raw.error };
  if (raw.status === 401 || raw.status === 403) return { status: raw.status, unauthorized: true };
  let body = raw.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return { status: raw.status, error: 'invalid json' }; }
  }
  return { status: raw.status, body: body };
}

// 带重试的状态抓取:页面刚加载时组织上下文可能还没就绪,接口会短暂 400,
// 等一会儿重试通常就好。401/403 直接返回(调用方判过期),不再重试。
async function fetchStatusWithRetry(win, logger, orgId, attempts, gapMs) {
  let last = { error: 'empty' };
  const rounds = Math.max(1, attempts || 3);
  for (let i = 0; i < rounds; i++) {
    let res = null;
    try {
      res = await fetchStatusJson(win, orgId);
    } catch (e) {
      res = { error: String((e && e.message) || e) };
    }
    if (res.unauthorized) return res;
    if (res.body && parseQuotaStatus(res.body)) return res;
    last = res;
    if (logger) logger.log('[opencode-go] status not ready, retrying (' + (i + 1) + '/' + rounds + ')');
    if (i < rounds - 1) await new Promise((resolve) => setTimeout(resolve, gapMs || 2500));
  }
  return last;
}

// 等待地址栏进入 <org>/go。allowAuth=true 时(登录流程)不把登录页判为过期,只管等。
async function waitForGoPage(win, timeoutMs, allowAuth) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let url = '';
    try { url = win.webContents.getURL(); } catch (e) {}
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch (e) {}
    if (isGoPath(pathname)) {
      const id = extractWorkspace(url);
      if (id) return { workspaceID: id };
    } else if (!allowAuth && isAuthPath(pathname)) {
      return { expired: true, url: url };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { timeout: true };
}

// 登录捕获:可见窗口打开 /auth → 用户 SSO 登录 → 自动跳 /console/<org>/go → 调接口拿用量。
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

    // 已登录落地到 workspace/console 页后,自动跳到 Go 订阅页
    win.webContents.on('did-navigate', (e, url) => {
      logger.log('[opencode-go] navigate:', url);
      const navWorkspaceID = extractWorkspace(url);
      let pathname = '';
      try { pathname = new URL(url).pathname; } catch (err) { return; }
      if (!isGoPath(pathname) && navWorkspaceID) {
        let origin = 'https://opencode.ai';
        try { origin = new URL(url).origin; } catch (err) {}
        const target = origin + '/console/' + navWorkspaceID + '/go';
        if (url !== target) {
          logger.log('[opencode-go] goto go page:', target);
          try { win.loadURL(target); } catch (err) {}
        }
      }
    });

    // 等进入 Go 页后调 /api/go/status 拿用量(最长 120s,覆盖登录时间)
    async function pollScrape() {
      const gate = await waitForGoPage(win, 120000, true);
      if (settled) return;
      if (gate.timeout || !gate.workspaceID) {
        fail(new Error('未进入 OpenCode Go 订阅页(请登录并进入 Go 订阅页)'));
        return;
      }
      workspaceID = gate.workspaceID;
      let api = null;
      try {
        api = await fetchStatusWithRetry(win, logger, workspaceID, 5, 2500);
      } catch (e) {
        api = { error: String((e && e.message) || e) };
      }
      if (settled) return;
      if (api && (api.unauthorized || /unauthoriz|401|403/i.test(api.error || ''))) {
        fail(new Error('登录后仍未授权(请确认该账号订阅了 OpenCode Go)'));
        return;
      }
      const quota = api && api.body ? parseQuotaStatus(api.body) : null;
      if (!quota) {
        logger.log('[opencode-go] api status unparsable:', JSON.stringify(api && (api.body || api.error)));
        // 兜底:旧 DOM 抓取(页面结构回退时仍可能命中)
        const items = await waitForUsage(win, 10000);
        const fallback = parseScrapedUsage(items);
        if (!fallback) {
          fail(new Error('未在订阅页找到用量数据(请确认登录并订阅了 OpenCode Go)'));
          return;
        }
        logger.log('[opencode-go] captured usage from DOM, windows:', fallback.windows.map((w) => w.kind).join(','));
        finish(fallback);
        return;
      }
      logger.log('[opencode-go] captured usage from api, windows:', quota.windows.map((w) => w.kind).join(','));
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

// 轮询:5 分钟缓存 + 隐藏窗口打开 /go 页,在页面上下文调 /api/go/status
// (会话在持久化 partition 里,无需手动 cookie)。
// 401/403 或落到登录页 → 抛错标记过期(调度器据此亮重新登录);其他失败回退缓存,绝不让卡片清空。
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
    await win.loadURL(goPageUrl(workspaceID));
    const gate = await waitForGoPage(win, 15000, false);
    if (gate.expired) {
      throw new Error('OpenCode Go 登录已过期,请重新登录');
    }
    const api = await fetchStatusWithRetry(win, logger, workspaceID, 4, 2500);
    if (api.unauthorized) {
      throw new Error('OpenCode Go 登录已过期,请重新登录');
    }
    const quota = api.body ? parseQuotaStatus(api.body) : null;
    if (quota) {
      cachedQuota = quota;
      cachedAt = Date.now();
      return quota;
    }
    logger.log('[opencode-go] poll api unparsable, trying DOM fallback');
    const items = await waitForUsage(win, 10000);
    if (items.length) {
      const fallback = parseScrapedUsage(items);
      if (fallback) {
        cachedQuota = fallback;
        cachedAt = Date.now();
        return fallback;
      }
    }
    logger.log('[opencode-go] poll scrape empty; keeping cached quota');
    return cachedQuota;
  } catch (e) {
    if (/登录已过期/.test((e && e.message) || '')) throw e;
    logger.log('[opencode-go] poll error:', e && e.message ? e.message : e, '; keeping cached quota');
    return cachedQuota;
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

module.exports = { captureSession, createSessionWindow, fetchQuota, readCred, writeCred, extractWorkspace, goPageUrl, isGoPath, scrapeUsageScript, CONSOLE_URL, PARTITION };
