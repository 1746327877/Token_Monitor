// 主进程 IPC 模块:全部 ipcMain 处理器 + 缩放状态机。
// 依赖由 index.js 注入(deps),窗口创建/生命周期仍留在 index.js。
const { ipcMain, BrowserWindow } = require('electron');
const { buildHeatmap } = require('./core/heatmap');
const { buildTokenCurve } = require('./core/locallog');
const { sanitizeSettings, isWritableSettingKey, resolveWritableSettingKey } = require('./core/settings-security');
const { resetSettingsStore } = require('./core/settings-reset');
const opencodeGoAuth = require('./providers/opencode-go/auth');
const commandGoatAuth = require('./providers/command-goat/auth');

function deepseekApiKeyCtx(deps, apiKey) {
  return {
    store: {
      get: (k) => (k === 'providers.deepseek.apiKey' ? apiKey : deps.store.get(k)),
      set: (k, v) => deps.store.set(k, v),
      delete: (k) => deps.store.delete(k)
    },
    logger: console,
    getProxyUrl: () => deps.store.get('providers.proxyUrl') || null
  };
}

module.exports = function setupIPC(deps) {
  let mainResizeState = null;
  let settingsResizeState = null;

  function getMain() {
    return deps.getMainWindow();
  }

  function getSettings() {
    return deps.getSettingsWindow();
  }

  function buildDashboardPayload(providerId) {
    const pid = providerId || 'deepseek';
    const st = deps.scheduler.getState(pid) || {};
    const payload = { providerId: pid, balance: st.balance || null };
    if (pid === 'deepseek' && st.usage) {
      const stats = {
        cost: st.usage.cost.aggregate,
        token: st.usage.amount.aggregate,
        costDaily: st.usage.cost.dailyData,
        tokenDaily: st.usage.amount.dailyData
      };
      payload.stats = stats;
      const curves = deps.buildCurvePoints(stats);
      payload.curveCost = curves.cost;
    }
    // Token 消耗趋势:全平台汇总(usageDaily,与每日 Token 消耗柱状图同源)
    payload.curveToken = buildTokenCurve(deps.store.get('usageDaily'));
    payload.proxyStatus = deps.runtime.proxyStatus;
    return payload;
  }

  /* ======== 登录 ======== */

  ipcMain.on('login:submit', async (event, { apiKey }) => {
    const main = getMain();
    try {
      const deepseek = deps.registry.get('deepseek');
      const info = await deepseek.fetchBalance(deepseekApiKeyCtx(deps, apiKey));
      if (!info) throw new Error('API Key 验证失败');
      deps.store.set('providers.deepseek.apiKey', apiKey);
      if (deps.getLoginWindow()) deps.getLoginWindow().close();
      if (!main) deps.createMainWindow();
      else main.show();
      const win = getMain();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.on('did-finish-load', () => {
          win.webContents.send('settings:loaded', sanitizeSettings(deps.store.store));
          deps.scheduler.poll('deepseek', 'balance');
          deps.createSessionWindow();
        });
      }
    } catch (e) {
      if (deps.getLoginWindow() && !deps.getLoginWindow().isDestroyed()) {
        event.sender.send('login:error', 'API Key 验证失败: ' + e.message);
      }
    }
  });

  /* ======== Dashboard / Providers ======== */

  ipcMain.handle('get:dashboard', (event, providerId) => {
    return buildDashboardPayload(providerId);
  });

  ipcMain.handle('get:providers', () => {
    return deps.scheduler.getSnapshot();
  });

  /* ======== OpenCode 使用卡片 ======== */

  ipcMain.handle('get:opencode-stats', () => {
    const provider = deps.registry.get('opencode');
    if (!provider || typeof provider.getStats !== 'function') {
      return { today: { date: null, tokens: 0, cost: 0, messages: 0, models: [] }, total: { tokens: 0, cost: 0, messages: 0, days: 0 } };
    }
    return provider.getStats({ store: deps.store, logger: console });
  });

  /* ======== OpenCode Go / Command Goat 额度登录(console/studio 捕获) ======== */

  function sessionWindow(title, partition) {
    return new BrowserWindow({
      width: 1000,
      height: 720,
      show: true,
      center: true,
      title: title,
      webPreferences: {
        partition: partition || 'persist:opencode-console',
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
  }

  async function loginOpenCodeGo() {
    const provider = deps.registry.get('opencode-go');
    if (!provider) return;
    try {
      await opencodeGoAuth.captureSession({
        store: deps.store,
        logger: console,
        createSessionWindow: () => sessionWindow('登录 OpenCode Go(console)', opencodeGoAuth.PARTITION)
      });
      if (deps.scheduler) deps.scheduler.poll('opencode-go', 'quota');
    } catch (e) {
      console.error('[opencode-go] login failed:', e && e.message ? e.message : e);
    }
  }

  async function loginCommandGoat() {
    const provider = deps.registry.get('command-goat');
    if (!provider) return;
    try {
      await commandGoatAuth.captureSession({
        store: deps.store,
        logger: console,
        createSessionWindow: () => sessionWindow('登录 Command Code Studio', commandGoatAuth.PARTITION)
      });
      if (deps.scheduler) deps.scheduler.poll('command-goat', 'quota');
    } catch (e) {
      console.error('[command-goat] login failed:', e && e.message ? e.message : e);
    }
  }

  const CONSOLE_LOGINS = {
    'opencode-go': loginOpenCodeGo,
    'command-goat': loginCommandGoat
  };

  ipcMain.on('login:opencode-go', () => {
    loginOpenCodeGo();
  });

  ipcMain.on('login:command-goat', () => {
    loginCommandGoat();
  });

  ipcMain.handle('get:command-goat-stats', () => {
    const provider = deps.registry.get('command-goat');
    if (!provider || typeof provider.getStats !== 'function') {
      return { tokens: 0, runs: 0, cost: 0 };
    }
    return provider.getStats({ store: deps.store, logger: console });
  });

  ipcMain.on('provider:reauth', (event, providerId) => {
    const login = CONSOLE_LOGINS[providerId];
    if (login) {
      login();
    } else if (deps.scheduler) {
      deps.scheduler.pollAll();
    }
  });

  /* ======== Heatmap ======== */

  ipcMain.handle('get:heatmap', (event, arg) => {
    const { provider, year } = arg || {};
    // 全部 provider 的日数据统一来自 store 键 'usageDaily' { '<provider>:<date>': { total, cached, models? } }:
    // codex/kimi 由本地日志增量聚合;deepseek 由 fetchUsage 按月抓取时持久化(含历史回填)。
    const usageDaily = deps.store.get('usageDaily') || {};
    const byProvider = {};
    const cachedByProvider = {};
    const deepseekModels = {};
    Object.keys(usageDaily).forEach((key) => {
      const idx = key.indexOf(':');
      if (idx <= 0) return;
      const pid = key.slice(0, idx);
      const date = key.slice(idx + 1);
      const total = Number(usageDaily[key] && usageDaily[key].total) || 0;
      if (total <= 0) return;
      byProvider[pid] = byProvider[pid] || {};
      byProvider[pid][date] = (byProvider[pid][date] || 0) + total;
      const cached = Number(usageDaily[key] && usageDaily[key].cached) || 0;
      if (cached > 0) {
        cachedByProvider[pid] = cachedByProvider[pid] || {};
        cachedByProvider[pid][date] = (cachedByProvider[pid][date] || 0) + cached;
      }
      // deepseek 悬停明细:当日模型分布(fetchUsage 持久化时写入)
      const models = usageDaily[key] && usageDaily[key].models;
      if (pid === 'deepseek' && Array.isArray(models) && models.length) {
        deepseekModels[date] = models.map((m) => ({ model: m.model, tokens: m.tokens }));
      }
    });
    const result = buildHeatmap(byProvider, provider || 'all', year || new Date().getFullYear());
    result.details = { byProvider: byProvider, cachedByProvider: cachedByProvider, deepseekModels: deepseekModels };
    return result;
  });

  /* ======== Settings ======== */

  ipcMain.on('settings:update', (event, { key, value }) => {
    if (!isWritableSettingKey(key)) {
      console.warn('[settings] rejected non-whitelisted settings:update key:', key);
      return;
    }
    const targetKey = resolveWritableSettingKey(key);
    deps.store.set(targetKey, value);
    deps.applySetting(targetKey, value);
    deps.broadcastSettings();
  });

  ipcMain.handle('get:settings', () => {
    return sanitizeSettings(deps.store.store);
  });

  ipcMain.on('settings:reset', () => {
    resetSettingsStore(deps.store);
    console.log('[settings] reset done (credentials and usage state preserved)');
    if (getMain()) {
      getMain().setAlwaysOnTop(true);
    }
    deps.broadcastSettings();
  });

  /* ======== Window geometry ======== */

  ipcMain.handle('get:bounds', () => {
    if (!getMain()) return null;
    return getMain().getBounds();
  });

  ipcMain.handle('window:commit', (event, bounds) => {
    if (!getMain()) return null;
    var next = deps.normalizeMainBounds(bounds);
    var current = getMain().getBounds();
    var sameSize = current.width === next.width && current.height === next.height;

    if (sameSize) {
      return deps.persistMainWindowBounds();
    }

    getMain().setBounds(next);
    return deps.persistMainWindowBounds();
  });

  ipcMain.on('window:set-bounds', (event, bounds) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== getMain() || win.isDestroyed()) return;
    var next = deps.normalizeMainBounds(bounds);
    var current = win.getBounds();
    if (current.x === next.x && current.y === next.y
        && current.width === next.width && current.height === next.height) {
      return;
    }
    win.setBounds(next, false);
  });

  ipcMain.on('window:minimize', () => {
    if (getMain()) getMain().hide();
  });

  // 切换主窗口置顶:写回设置并广播,标题栏图钉按钮同步状态
  ipcMain.on('window:toggle-always-on-top', () => {
    const next = !deps.store.get('window.alwaysOnTop');
    deps.store.set('window.alwaysOnTop', next);
    if (getMain()) getMain().setAlwaysOnTop(next);
    deps.broadcastSettings();
  });

  ipcMain.on('zoom:change', (event, { delta }) => {
    if (!getMain() || getMain().isDestroyed()) return;
    var current = getMain().webContents.getZoomFactor();
    var next = Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 100) / 100));
    getMain().webContents.setZoomFactor(next);
    deps.store.set('window.zoomFactor', next);
  });

  ipcMain.on('session:relogin', () => {
    deps.createSessionWindow();
  });

  ipcMain.handle('get:session-state', () => {
    return { loggedIn: !!deps.runtime.sessionToken, error: deps.runtime.proxyStatus.error || null };
  });

  ipcMain.on('window:close', () => {
    if (deps.getLoginWindow()) deps.getLoginWindow().close();
  });

  ipcMain.on('window:close-settings', () => {
    const win = getSettings();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('refresh:dashboard', async () => {
    await deps.scheduler.pollAll();
  });

  ipcMain.on('open:settings', (event) => {
    deps.createSettingsWindow();
  });

  /* ======== 缩放状态机(resize IPC 原样搬入,逻辑零改动) ======== */

  function getResizeState(win) {
    if (win === getMain()) return mainResizeState;
    if (win === getSettings()) return settingsResizeState;
    return null;
  }

  function setResizeState(win, state) {
    if (win === getMain()) {
      mainResizeState = state;
      deps.resizeState.main = !!state;
    } else if (win === getSettings()) {
      settingsResizeState = state;
      deps.resizeState.settings = !!state;
    }
  }

  function applyResizeBounds(win, state) {
    if (!state || !state.pendingBounds || !win || win.isDestroyed()) return;
    var next = state.pendingBounds;
    state.pendingBounds = null;
    var current = win.getBounds();
    if (current.x !== next.x || current.y !== next.y
        || current.width !== next.width || current.height !== next.height) {
      win.setBounds(next, false);
    }
  }

  function scheduleResizeFrame(win, state) {
    if (state.timer) return;
    state.timer = setTimeout(function () {
      state.timer = null;
      if (getResizeState(win) !== state) return;
      applyResizeBounds(win, state);
    }, 16);
  }

  function flushResizeFrame(win, state) {
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    applyResizeBounds(win, state);
  }

  ipcMain.on('resize:start', (event, { edge, screenX, screenY }) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var bounds = win.getBounds();
    setResizeState(win, {
      edge: edge,
      startBounds: bounds,
      startScreenX: screenX,
      startScreenY: screenY,
      pendingBounds: null,
      timer: null
    });
  });

  ipcMain.on('resize:move', (event, { screenX, screenY }) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    if (!state) return;

    var dx = screenX - state.startScreenX;
    var dy = screenY - state.startScreenY;
    var newBounds = { x: state.startBounds.x, y: state.startBounds.y, width: state.startBounds.width, height: state.startBounds.height };
    var edge = state.edge;
    var isSettings = win === getSettings();
    var minW = isSettings ? 340 : 380;
    var minH = isSettings ? 440 : 200;
    var maxW = isSettings ? 1600 : 2400;
    var maxH = isSettings ? 1200 : 1600;

    if (edge.indexOf('e') !== -1) {
      newBounds.width = Math.min(maxW, Math.max(minW, state.startBounds.width + dx));
    }
    if (edge.indexOf('w') !== -1) {
      var proposedW = Math.min(maxW, Math.max(minW, state.startBounds.width - dx));
      newBounds.x = state.startBounds.x + state.startBounds.width - proposedW;
      newBounds.width = proposedW;
    }
    if (edge.indexOf('s') !== -1) {
      newBounds.height = Math.min(maxH, Math.max(minH, state.startBounds.height + dy));
    }
    if (edge.indexOf('n') !== -1) {
      var proposedH = Math.min(maxH, Math.max(minH, state.startBounds.height - dy));
      newBounds.y = state.startBounds.y + state.startBounds.height - proposedH;
      newBounds.height = proposedH;
    }

    state.pendingBounds = newBounds;
    scheduleResizeFrame(win, state);
  });

  ipcMain.on('resize:end', (event) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    flushResizeFrame(win, state);
    setResizeState(win, null);

    if (win === getMain()) {
      deps.persistMainWindowBounds();
      deps.sendMainWindowBounds();
    }
  });
};
