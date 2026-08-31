// Command Code 双号自动切换代理管理。
// 用户提供 cc-proxy.py(python http 代理:转发到 api.commandcode.ai,遇到 403/429 自动切号),
// 本模块在监控器启动时拉起它、退出时停掉。Key 优先级:系统环境变量 > 监控器设置里填的。
const { spawn } = require('child_process');

let proc = null;
let startedFor = null;

const CONFIG_DEFAULTS = {
  enabled: false,
  pythonPath: 'python',
  scriptPath: 'D:\\code\\tools\\cc-proxy.py'
};

function getConfig(store) {
  const cfg = {};
  Object.keys(CONFIG_DEFAULTS).forEach((k) => {
    cfg[k] = (store && store.get('ccProxy.' + k)) !== undefined
      ? store.get('ccProxy.' + k)
      : CONFIG_DEFAULTS[k];
  });
  return cfg;
}

// Key 合并:环境变量优先,store 里填的作为补充(去重)。
function resolveKeys(store) {
  const keys = [];
  const seen = new Set();
  const push = (k) => {
    k = (k || '').trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  ['COMMAND_CODE_API_KEY', 'COMMAND_CODE_API_KEY_2'].forEach((envName) => {
    push(process.env[envName]);
  });
  ['key1', 'key2'].forEach((storeKey) => {
    push(store && store.get('ccProxy.' + storeKey));
  });
  return keys;
}

function buildEnv(store) {
  const keys = resolveKeys(store);
  const env = Object.assign({}, process.env);
  keys.forEach((k, i) => {
    env['COMMAND_CODE_API_KEY' + (i === 0 ? '' : '_' + (i + 1))] = k;
  });
  // 多余的旧变量清掉,避免脚本读到残留的第三个 key
  for (let i = keys.length; i < 8; i += 1) {
    const name = i === 0 ? 'COMMAND_CODE_API_KEY' : 'COMMAND_CODE_API_KEY_' + (i + 1);
    delete env[name];
  }
  // cc-proxy.py 用 print 输出 emoji,Windows GBK 控制台会 UnicodeEncodeError 崩溃 → 强制 UTF-8
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

function start(store, logger) {
  const log = logger || console;
  stop();
  const cfg = getConfig(store);
  if (!cfg.enabled) {
    startedFor = null;
    return null;
  }
  const keys = resolveKeys(store);
  if (keys.length < 2) {
    log.warn('[cc-proxy] 需要至少 2 个 API Key(环境变量或设置中),代理未启动');
    startedFor = null;
    return null;
  }
  try {
    const child = spawn(cfg.pythonPath, [cfg.scriptPath], {
      env: buildEnv(store),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', (d) => { log.log('[cc-proxy]', String(d).trim()); });
    child.stderr.on('data', (d) => { log.error('[cc-proxy]', String(d).trim()); });
    child.on('error', (err) => {
      log.error('[cc-proxy] 启动失败:', err && err.message ? err.message : err);
      proc = null;
      startedFor = null;
    });
    child.on('exit', (code, signal) => {
      if (proc === child) {
        proc = null;
        startedFor = null;
        log.log('[cc-proxy] 代理进程退出 code=' + code + ' signal=' + signal);
      }
    });
    proc = child;
    startedFor = JSON.stringify({ cfg, keys });
    log.log('[cc-proxy] 已启动 ' + cfg.pythonPath + ' ' + cfg.scriptPath + ' (keys=' + keys.length + ')');
    return child;
  } catch (e) {
    log.error('[cc-proxy] 启动异常:', e && e.message ? e.message : e);
    return null;
  }
}

function stop() {
  if (proc) {
    try { proc.kill(); } catch (e) {}
    proc = null;
  }
  startedFor = null;
}

// 配置变化(开关/路径/key)后重启。
function restartIfNeeded(store, logger) {
  const current = JSON.stringify({ cfg: getConfig(store), keys: resolveKeys(store) });
  if (startedFor === current) return;
  start(store, logger);
}

function isRunning() {
  return !!(proc && proc.pid);
}

module.exports = { start, stop, restartIfNeeded, isRunning, getConfig, resolveKeys, buildEnv };
