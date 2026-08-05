// OpenCode Go console 登录捕获:弹窗打开 opencode.ai/workspace,用户 SSO 登录后,
// 拦截 _server 的 lite.subscription.get 请求,记录 { url, requestBody, cookie, headers }。
// 之后轮询复用同一 Cookie(见 quota.js fetchQuota)。
const { BrowserWindow } = require('electron');
const { parseQuota, CRED_KEY } = require('./quota');

const CONSOLE_URL = 'https://opencode.ai/auth';
const QUERY_NAME = 'lite.subscription.get';

function createSessionWindow() {
  return new BrowserWindow({
    width: 920,
    height: 700,
    show: true,
    center: true,
    title: '登录 OpenCode Go(console)',
    webPreferences: {
      partition: 'persist:opencode-console',
      contextIsolation: true,
      nodeIntegration: false
    }
  });
}

function readCred(store) {
  return (store && store.get(CRED_KEY)) || null;
}

function writeCred(store, cred) {
  if (store) store.set(CRED_KEY, cred);
}

function clearCred(store) {
  if (store) store.delete(CRED_KEY);
}

// 从 webRequest uploadData 还原 POST body。
function bodyFromUpload(uploadData) {
  if (!Array.isArray(uploadData)) return '';
  let text = '';
  (uploadData || []).forEach((chunk) => {
    if (chunk && chunk.bytes) text += chunk.bytes.toString('utf8');
  });
  return text;
}

// 捕获重放所需的请求头:保留 cookie/origin/referer/UA/content-type/accept 与 x-* 自定义头,
// 排除 hop-by-hop(host/content-length/connection 等)与压缩协商头。
const HOP_BY_HOP = /^(host|content-length|connection|keep-alive|transfer-encoding|accept-encoding|upgrade|pragma|cache-control|sec-fetch-|sec-ch-ua|te)$/i;
function pickHeaders(headers) {
  const picked = {};
  Object.keys(headers || {}).forEach((k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.test(lk)) return;
    if (/^x-/.test(lk) || ['cookie', 'origin', 'referer', 'user-agent', 'accept', 'content-type'].indexOf(lk) !== -1) {
      picked[k] = headers[k];
    }
  });
  return picked;
}

function extractWorkspace(requestBody) {
  try {
    const parsed = JSON.parse(requestBody);
    const args = Array.isArray(parsed && parsed.args) ? parsed.args : [];
    return typeof args[0] === 'string' ? args[0] : null;
  } catch (e) {
    return null;
  }
}

// 登录捕获:成功 resolve 归一化后的 QuotaState,并已写入 store。
// 策略:收集窗口内所有发往 /_server 的 POST(不限函数名位置,body 或 URL 均可),
// 页面加载完成后逐个在页内重放,直到解析出 lite.subscription.get 的用量结构。
function captureSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = (ctx && typeof ctx.createSessionWindow === 'function')
      ? ctx.createSessionWindow()
      : createSessionWindow();
    const ses = win.webContents.session;
    let settled = false;
    const captures = [];
    let replayTimer = null;
    let watchTimer = null;
    let lastActivity = Date.now();

    const finish = (quota, cred) => {
      if (settled) return;
      settled = true;
      clearTimeout(replayTimer);
      clearInterval(watchTimer);
      writeCred(ctx && ctx.store, cred);
      try { win.close(); } catch (e) {}
      resolve(quota);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(replayTimer);
      clearInterval(watchTimer);
      logger.error('[opencode-go] capture failed:', err && err.message ? err.message : err);
      try { win.close(); } catch (e) {}
      reject(err);
    };

    // 捕获所有发往 opencode.ai 的 POST(server function 路径不限于 /_server,先全收再逐个重放)
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.method === 'POST' && /^https:\/\/opencode\.ai\//.test(details.url)) {
        lastActivity = Date.now();
        const body = bodyFromUpload(details.requestBody && details.requestBody.uploadData);
        captures.push({
          url: details.url,
          requestBody: body,
          cookie: details.requestHeaders['cookie'] || '',
          headers: pickHeaders(details.requestHeaders)
        });
        logger.log('[opencode-go] captured POST:', details.url, '| body:', body.slice(0, 160));
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    // 已登录落地到 workspace 页后,自动跳到 Go 订阅页以触发用量请求(保留语言前缀)
    win.webContents.on('did-navigate', (e, url) => {
      logger.log('[opencode-go] navigate:', url);
      const m = /(.*\/workspace\/[^/?#]+)/.exec(url);
      if (!m) return;
      let pathname;
      try { pathname = new URL(url).pathname; } catch (err) { return; }
      if (!/\/go(\/|$)/.test(pathname)) {
        logger.log('[opencode-go] goto go page:', m[1] + '/go');
        win.loadURL(m[1] + '/go');
      }
    });

    // 依次重放捕获到的请求,直到解析出用量结构
    function replayAll(index) {
      if (settled) return;
      if (index >= captures.length) {
        logger.log('[opencode-go] no usage payload among ' + captures.length + ' captured requests');
        fail(new Error('未捕获到 OpenCode Go 用量数据(请确认订阅了 Go 套餐并进入订阅页)'));
        return;
      }
      const cap = captures[index];
      const bodyLiteral = JSON.stringify(cap.requestBody);
      const replayHeaders = Object.assign({ 'Content-Type': 'application/json' }, cap.headers || {});
      delete replayHeaders.cookie;
      delete replayHeaders.Cookie;
      const headersLiteral = JSON.stringify(replayHeaders);
      win.webContents.executeJavaScript(
        'fetch(' + JSON.stringify(cap.url) + ',{method:"POST",headers:' + headersLiteral + ',body:' + bodyLiteral + '}).then(r=>r.text())'
      )
        .then((text) => {
          logger.log('[opencode-go] replay #' + index + ' ->', text.slice(0, 200));
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (e) {}
          const quota = parseQuota(parsed);
          if (!quota) {
            replayAll(index + 1);
            return;
          }
          const cred = {
            workspaceID: extractWorkspace(cap.requestBody),
            url: cap.url,
            cookie: cap.cookie,
            requestBody: cap.requestBody,
            headers: cap.headers,
            capturedAt: Date.now()
          };
          finish(quota, cred);
        })
        .catch((e) => {
          logger.log('[opencode-go] replay #' + index + ' error:', e && e.message ? e.message : e);
          replayAll(index + 1);
        });
    }

    function scheduleReplay() {
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        if (!settled) replayAll(0);
      }, 500);
    }

    ses.webRequest.onCompleted((details) => {
      if (!settled && details.method === 'POST' && /^https:\/\/opencode\.ai\//.test(details.url)) {
        scheduleReplay();
      }
    });

    // 兜底:窗口持续打开但一直没抓到 _server 请求时给出诊断(120s 后)
    watchTimer = setInterval(() => {
      if (settled) { clearInterval(watchTimer); return; }
      if (captures.length) { clearInterval(watchTimer); return; }
      if (Date.now() - lastActivity > 120000) {
        logger.log('[opencode-go] no _server request captured for 120s, last activity:', new Date(lastActivity).toISOString());
      }
    }, 30000);

    win.webContents.on('did-fail-load', (event, code, desc) => {
      logger.log('[opencode-go] did-fail-load:', code, desc);
      if (!settled) fail(new Error('登录窗口加载失败: ' + desc));
    });
    win.on('closed', () => {
      if (!settled) {
        logger.log('[opencode-go] window closed without capture');
        fail(new Error('未捕获到 OpenCode Go 用量接口(请登录并进入 Go 订阅页)'));
      }
    });

    logger.log('[opencode-go] capture session start ->', CONSOLE_URL);
    win.loadURL(CONSOLE_URL);
  });
}

module.exports = { captureSession, createSessionWindow, readCred, writeCred, clearCred, extractWorkspace, bodyFromUpload, pickHeaders, CONSOLE_URL, QUERY_NAME };
