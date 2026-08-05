// OpenCode Go console 登录捕获:弹窗打开 opencode.ai/workspace,用户 SSO 登录后,
// 拦截 _server 的 lite.subscription.get 请求,记录 { url, requestBody, cookie, headers }。
// 之后轮询复用同一 Cookie(见 quota.js fetchQuota)。
const { BrowserWindow } = require('electron');
const { parseQuota, CRED_KEY } = require('./quota');

const CONSOLE_URL = 'https://opencode.ai/workspace';
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

// 捕获重放所需的来源头(排除 hop-by-hop 与 body 相关)。
function pickHeaders(headers) {
  const picked = {};
  ['origin', 'referer', 'user-agent'].forEach((k) => {
    if (headers && headers[k]) picked[k] = headers[k];
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
function captureSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = (ctx && typeof ctx.createSessionWindow === 'function')
      ? ctx.createSessionWindow()
      : createSessionWindow();
    const ses = win.webContents.session;
    let settled = false;
    let found = null;
    let replayTimer = null;

    const finish = (quota, cred) => {
      if (settled) return;
      settled = true;
      writeCred(ctx && ctx.store, cred);
      clearTimeout(replayTimer);
      try { win.close(); } catch (e) {}
      resolve(quota);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(replayTimer);
      logger.error('[opencode-go] capture failed:', err && err.message ? err.message : err);
      try { win.close(); } catch (e) {}
      reject(err);
    };

    // 捕获用量请求的 URL / body / Cookie / 来源头
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!found && details.url.indexOf('/_server') !== -1) {
        const body = bodyFromUpload(details.requestBody && details.requestBody.uploadData);
        if (body.indexOf(QUERY_NAME) !== -1) {
          found = {
            url: details.url,
            requestBody: body,
            cookie: details.requestHeaders['cookie'] || '',
            headers: pickHeaders(details.requestHeaders)
          };
          logger.log('[opencode-go] captured _server usage request:', details.url);
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    // 已登录落地到 workspace 页后,自动跳到 Go 订阅页以触发用量请求
    win.webContents.on('did-navigate', (e, url) => {
      const m = /workspace\/([^/?#]+)/.exec(url);
      if (!m) return;
      try {
        const pathname = new URL(url).pathname;
        if (!/^\/workspace\/[^/]+\/go/.test(pathname)) {
          win.loadURL('https://opencode.ai/workspace/' + m[1] + '/go');
        }
      } catch (err) {}
    });

    // 捕获到请求后,页面内重放 fetch 拿真实 JSON(自动携带 cookie)
    function replay() {
      if (settled || !found) return;
      const bodyLiteral = JSON.stringify(found.requestBody);
      win.webContents.executeJavaScript(
        'fetch(' + JSON.stringify(found.url) + ',{method:"POST",headers:{"Content-Type":"application/json"},body:' + bodyLiteral + '}).then(r=>r.text())'
      )
        .then((text) => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (e) {}
          const quota = parseQuota(parsed);
          if (!quota) {
            fail(new Error('用量响应解析失败'));
            return;
          }
          const cred = {
            workspaceID: extractWorkspace(found.requestBody),
            url: found.url,
            cookie: found.cookie,
            requestBody: found.requestBody,
            headers: found.headers,
            capturedAt: Date.now()
          };
          finish(quota, cred);
        })
        .catch((e) => fail(e));
    }

    ses.webRequest.onCompleted((details) => {
      if (found && !settled && details.url.indexOf('/_server') !== -1) {
        clearTimeout(replayTimer);
        replayTimer = setTimeout(replay, 400);
      }
    });

    win.webContents.on('did-fail-load', (event, code, desc) => {
      if (!settled) fail(new Error('登录窗口加载失败: ' + desc));
    });
    win.on('closed', () => {
      if (!settled) fail(new Error('未捕获到 OpenCode Go 用量接口(请登录并进入 Go 订阅页)'));
    });

    win.loadURL(CONSOLE_URL);
  });
}

module.exports = { captureSession, createSessionWindow, readCred, writeCred, clearCred, extractWorkspace, bodyFromUpload, pickHeaders, CONSOLE_URL, QUERY_NAME };
