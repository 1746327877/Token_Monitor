// opencode 本地会话消息读取:storage/message/<sessionID>/<messageID>.json。
// 与 codex/kimi 的 JSONL 追加日志不同:每个消息是独立 JSON 文件,完成前可能被反复改写,
// 因此按 {size, mtimeMs} 判变更 + 按消息 id 去重,已计入的 completed 消息不再重复统计。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDayStr } = require('../../core/locallog');

// Windows 下 opencode 数据目录为 %USERPROFILE%\.local\share\opencode(storage 统一走 XDG 布局)
const DEFAULT_ROOT = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'message');
const MATCH = /\.json$/;
const CURSOR_KEY = 'localLogCursors.opencode';

// 解析单条消息文件,仅统计已完成的 assistant 消息。
// 字段语义对照 opencode src/session/session.ts updateCostAndTokens:
//   input  = tokens.input(已扣除缓存读写)
//   cached = tokens.cache.read
//   output = tokens.output + tokens.reasoning(reasoning 单独计费,费率同 output)
//   total  = input + cached + output
function parseMessageFile(fileText) {
  if (!fileText) return null;
  let data;
  try {
    data = JSON.parse(fileText);
  } catch (e) {
    return null;
  }
  if (!data || data.role !== 'assistant') return null;
  const completed = data.time && data.time.completed;
  if (!completed || !data.tokens) return null;
  const tokens = data.tokens || {};
  const cache = tokens.cache || {};
  const input = Number(tokens.input) || 0;
  const cached = Number(cache.read) || 0;
  const output = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  return {
    id: data.id || null,
    ts: Number(completed) || null,
    model: data.modelID || null,
    usage: {
      input: input,
      cached: cached,
      output: output,
      total: input + cached + output
    },
    cost: Number(data.cost) || 0
  };
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

// 增量扫描本机 opencode 会话,返回新增 UsageRecord[];并按日聚合增量合并进 store 键 'usageDaily'。
// ctx = { store, ... }。root 可通过 store 键 'providers.opencode.localLogRoot' 覆盖(测试用)。
function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const root = (store && store.get('providers.opencode.localLogRoot')) || DEFAULT_ROOT();
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

module.exports = {
  parseMessageFile,
  scanMessageFiles,
  rollupRecords,
  mergeModelArrays,
  readLocalLog,
  getStats,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY
};
