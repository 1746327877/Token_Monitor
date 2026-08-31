// opencode 本地会话消息读取。
// 新版 opencode(桌面端 v2)把消息存进 SQLite `opencode.db`(message 表,data 为 JSON),
// 不再写 storage/message/**/*.json。主路径读 SQLite(全量重算,天然处理流式更新);
// 若 DB 不存在则回退到旧 JSON 文件增量扫描。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDayStr } = require('../../core/locallog');

const DEFAULT_ROOT = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'message');
const DEFAULT_DB_PATH = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const MATCH = /\.json$/;
const CURSOR_KEY = 'localLogCursors.opencode';

// 已有独立平台监控的 provider:这些用量由对应平台卡片统计(command-goat),
// opencode 本地统计应排除,避免同源用量被重复计数。
// 注意:opencode-go / deepseek 暂不排除(它们各自没有独立的每日 token 图表,
// 用户习惯在 opencode 里看;且它们不属于 cmd 套餐)。
const EXCLUDED_PROVIDERS = new Set(['command-code', 'commandcode']);

// 解析单条消息(data 为消息对象),仅统计已完成的 assistant 消息。
// 字段语义对照 opencode src/session/session.ts updateCostAndTokens:
//   input  = tokens.input(已扣除缓存读写)
//   cached = tokens.cache.read
//   output = tokens.output + tokens.reasoning(reasoning 单独计费,费率同 output)
//   total  = tokens.total(含缓存读取)或 input + cached + output
// V2 兼容:role 缺省(调用方已按表 type='assistant' 过滤)、providerID 在 data.model.providerID、
//   tokens 无 total 字段(自己相加)。keepExcluded 为 true 时不过滤 commandcode(供 command-goat 统计)。
function parseMessageData(data, fallbackId, opts) {
  if (!data) return null;
  if (data.role && data.role !== 'assistant') return null;
  const o = opts || {};
  const providerID = data.providerID || (data.model && data.model.providerID) || null;
  if (!o.keepExcluded && providerID && EXCLUDED_PROVIDERS.has(providerID)) return null;
  const completed = data.time && data.time.completed;
  if (!completed || !data.tokens) return null;
  const tokens = data.tokens || {};
  const cache = tokens.cache || {};
  const input = Number(tokens.input) || 0;
  const cached = Number(cache.read) || 0;
  const output = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  return {
    id: data.id || fallbackId || null,
    ts: Number(completed) || null,
    model: data.modelID || (data.model && data.model.id) || null,
    provider: providerID,
    usage: {
      input: input,
      cached: cached,
      output: output,
      total: Number(tokens.total) || (input + cached + output)
    },
    cost: Number(data.cost) || 0
  };
}

function parseMessageFile(fileText) {
  if (!fileText) return null;
  let data;
  try {
    data = JSON.parse(fileText);
  } catch (e) {
    return null;
  }
  return parseMessageData(data);
}

function walkJsonFiles(root, match) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    });
  };
  walk(root);
  return out;
}

// 增量扫描消息文件,返回新增 UsageRecord[]。
// cursor: { [absPath]: { size, mtimeMs, counted: { [messageId]: true } } }
function scanMessageFiles({ root, match, cursorStore, cursorKey, parseFile }) {
  const records = [];
  if (!root || !fs.existsSync(root)) return records;

  const cursors = cursorStore.get(cursorKey) || {};
  const files = walkJsonFiles(root, match);

  files.forEach((filePath) => {
    const cursor = cursors[filePath] || { size: 0, mtimeMs: 0, counted: {} };
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { return; }

    if (cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs) {
      cursors[filePath] = cursor;
      return;
    }

    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { return; }
    const rec = parseFile(text);
    if (rec && rec.id && !cursor.counted[rec.id]) {
      cursor.counted[rec.id] = true;
      records.push(rec);
    }
    cursor.size = stat.size;
    cursor.mtimeMs = stat.mtimeMs;
    cursors[filePath] = cursor;
  });

  Object.keys(cursors).forEach((p) => {
    if (!fs.existsSync(p)) delete cursors[p];
  });
  cursorStore.set(cursorKey, cursors);

  return records;
}

function mergeModelArrays(prev, add) {
  const merged = {};
  (prev || []).forEach((m) => {
    merged[m.model] = { model: m.model, tokens: m.tokens, cost: m.cost, messages: m.messages };
  });
  (add || []).forEach((m) => {
    const cur = merged[m.model] || { model: m.model, tokens: 0, cost: 0, messages: 0 };
    cur.tokens += m.tokens;
    cur.cost += m.cost;
    cur.messages += m.messages;
    merged[m.model] = cur;
  });
  return Object.keys(merged)
    .map((model) => merged[model])
    .sort((a, b) => b.tokens - a.tokens);
}

// 纯函数:records → { 'opencode:<YYYY-MM-DD>': { input, cached, output, total, cost, messages, models[] } }。
function rollupRecords(records) {
  const out = {};
  (records || []).forEach((rec) => {
    const ts = Number(rec.ts) || Date.now();
    const day = localDayStr(ts);
    const key = 'opencode:' + day;
    const entry = out[key] || { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} };
    const usage = rec.usage || {};
    entry.input += Number(usage.input) || 0;
    entry.cached += Number(usage.cached) || 0;
    entry.output += Number(usage.output) || 0;
    entry.total += Number(usage.total) || 0;
    entry.cost += Number(rec.cost) || 0;
    entry.messages += 1;
    if (rec.model) {
      const m = entry.models[rec.model] || { tokens: 0, cost: 0, messages: 0 };
      m.tokens += Number(usage.total) || 0;
      m.cost += Number(rec.cost) || 0;
      m.messages += 1;
      entry.models[rec.model] = m;
    }
    out[key] = entry;
  });
  Object.keys(out).forEach((key) => {
    const models = Object.keys(out[key].models)
      .map((model) => Object.assign({ model: model }, out[key].models[model]))
      .sort((a, b) => b.tokens - a.tokens);
    out[key].models = models;
  });
  return out;
}

function mergeOpenCodeDaily(store, records) {
  if (!store) return;
  const daily = rollupRecords(records);
  const usageDaily = store.get('usageDaily') || {};
  Object.keys(usageDaily).forEach((k) => {
    if (k.indexOf('opencode:') === 0) delete usageDaily[k];
  });
  Object.keys(daily).forEach((k) => { usageDaily[k] = daily[k]; });
  store.set('usageDaily', usageDaily);
}

// 全量重算 opencode 每日聚合(覆盖旧键,避免重复计数)。
// 优先读 V2 `session_message` 表(type 列区分角色),回退 V1 `message` 表(role 字段)。
// 返回 records;打不开 DB 返回 null(调用方回退 JSON)。
function readLocalLogFromDb(store, dbPath) {
  let DatabaseSync = null;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return null;
  }
  try {
    const records = readMessagesFromDb(db);
    mergeOpenCodeDaily(store, records);
    return records;
  } catch (e) {
    return null;
  } finally {
    try { db.close(); } catch (e) {}
  }
}

// 从已打开的 db 读取 opencode 消息记录:
//   V2:session_message 表存在 → SELECT 该表(type='assistant')
//   V1:回退 message 表(SELECT 全量,parseMessageData 按 role 过滤)
function readMessagesFromDb(db) {
  const hasSessionMessage = db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='session_message'"
  ).get().c > 0;

  const records = [];
  if (hasSessionMessage) {
    // V2:角色在 type 列,providerID 在 data.model.providerID;只取已完成且有 tokens 的 assistant
    const rows = db.prepare("SELECT id, time_created, data FROM session_message WHERE type='assistant'").all();
    rows.forEach((row) => {
      let data;
      try { data = JSON.parse(row.data); } catch (e) { data = null; }
      const rec = parseMessageData(data, row.id);
      if (rec) records.push(rec);
    });
  } else {
    const rows = db.prepare('SELECT id, time_created, data FROM message').all();
    rows.forEach((row) => {
      let data;
      try { data = JSON.parse(row.data); } catch (e) { data = null; }
      const rec = parseMessageData(data, row.id);
      if (rec) records.push(rec);
    });
  }
  return records;
}

// JSON 回退路径:增量扫描 storage/message/**/*.json。
function readLocalLogFromJson(ctx, store, root) {
  if (!fs.existsSync(root)) return [];
  const records = scanMessageFiles({
    root: root,
    match: MATCH,
    cursorStore: store,
    cursorKey: CURSOR_KEY,
    parseFile: parseMessageFile
  });
  if (records.length && store) {
    const daily = rollupRecords(records);
    const usageDaily = store.get('usageDaily') || {};
    Object.keys(daily).forEach((key) => {
      const add = daily[key];
      const prev = usageDaily[key] || { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: [] };
      usageDaily[key] = {
        input: prev.input + add.input,
        cached: prev.cached + add.cached,
        output: prev.output + add.output,
        total: prev.total + add.total,
        cost: (prev.cost || 0) + add.cost,
        messages: (prev.messages || 0) + add.messages,
        models: mergeModelArrays(prev.models, add.models)
      };
    });
    store.set('usageDaily', usageDaily);
  }
  return records;
}

// 读取本机 opencode 用量:优先 SQLite,JSON 回退。
// ctx = { store, ... }。db 路径可经 'providers.opencode.dbPath' 覆盖;JSON 根经 'localLogRoot' 覆盖(测试用)。
function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const rootOverride = store && store.get('providers.opencode.localLogRoot');
  if (rootOverride) {
    return readLocalLogFromJson(ctx, store, rootOverride);
  }
  const dbPath = (store && store.get('providers.opencode.dbPath')) || DEFAULT_DB_PATH();
  if (fs.existsSync(dbPath)) {
    const records = readLocalLogFromDb(store, dbPath);
    if (records) return records;
  }
  return readLocalLogFromJson(ctx, store, DEFAULT_ROOT());
}

// 从 store 键 'usageDaily' 读取 opencode 聚合,返回卡片展示数据(今日 + 累计)。
function getStats(ctx) {
  const store = ctx && ctx.store;
  const usageDaily = (store && store.get('usageDaily')) || {};
  const todayStr = localDayStr(Date.now());
  const today = { date: todayStr, tokens: 0, cost: 0, messages: 0, models: [] };
  const total = { tokens: 0, cost: 0, messages: 0, days: 0 };
  Object.keys(usageDaily).forEach((key) => {
    const idx = key.indexOf(':');
    if (idx <= 0) return;
    if (key.slice(0, idx) !== 'opencode') return;
    const date = key.slice(idx + 1);
    const entry = usageDaily[key] || {};
    total.tokens += Number(entry.total) || 0;
    total.cost += Number(entry.cost) || 0;
    total.messages += Number(entry.messages) || 0;
    total.days += 1;
    if (date === todayStr) {
      today.tokens = Number(entry.total) || 0;
      today.cost = Number(entry.cost) || 0;
      today.messages = Number(entry.messages) || 0;
      today.models = entry.models || [];
    }
  });
  return { today: today, total: total };
}

// 读取 opencode.db 里 command-code/commandcode 消息的每日聚合。
// 用户在 opencode 里用 cmd 套餐,消息都在这里(按天精确);command-goat 卡片用它做每日 token 统计,
// 不再依赖网页上被四舍五入的月度总量。
// V2:session_message 表(type 列);V1:message 表。keepExcluded 让 commandcode 记录通过 parseMessageData。
function readCommandCodeDaily(dbPath) {
  let DatabaseSync = null;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    return {};
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return {};
  }
  try {
    const hasSessionMessage = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='session_message'"
    ).get().c > 0;

    const out = {};
    const acc = (rec) => {
      if (!rec) return;
      if (rec.provider !== 'command-code' && rec.provider !== 'commandcode') return;
      const day = localDayStr(rec.ts);
      const e = out[day] || { total: 0, cost: 0, messages: 0 };
      e.total += rec.usage.total;
      e.cost += rec.cost;
      e.messages += 1;
      out[day] = e;
    };

    if (hasSessionMessage) {
      const rows = db.prepare("SELECT id, time_created, data FROM session_message WHERE type='assistant'").all();
      rows.forEach((row) => {
        let data;
        try { data = JSON.parse(row.data); } catch (e) { data = null; }
        acc(parseMessageData(data, row.id, { keepExcluded: true }));
      });
    } else {
      const rows = db.prepare('SELECT id, time_created, data FROM message').all();
      rows.forEach((row) => {
        let data;
        try { data = JSON.parse(row.data); } catch (e) { data = null; }
        acc(parseMessageData(data, row.id, { keepExcluded: true }));
      });
    }
    return out;
  } catch (e) {
    return {};
  } finally {
    try { db.close(); } catch (e) {}
  }
}

module.exports = {
  parseMessageData,
  parseMessageFile,
  scanMessageFiles,
  rollupRecords,
  mergeModelArrays,
  readLocalLog,
  readLocalLogFromDb,
  readCommandCodeDaily,
  getStats,
  DEFAULT_ROOT,
  DEFAULT_DB_PATH,
  MATCH,
  CURSOR_KEY
};
