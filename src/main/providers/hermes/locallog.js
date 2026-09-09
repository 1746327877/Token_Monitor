// Hermes 本地用量读取。
// 数据源:C:\Users\BaFeii7\AppData\Local\hermes\state.db(SQLite)
//   session_model_usage 表:每行 = session+model+task 的累计量,行随会话增长
//     (ON CONFLICT 累加,last_seen 更新,first_seen 固定)。
//   messages 表:每消息 timestamp + role(无 token),用于首次历史导入时按日比例拆分。
// 策略:
//   首轮(无基线)= 一次性导历史 → 每行累计量按该会话 messages 的每日 assistant 消息数
//     比例拆到 first_seen..last_seen 之间的日期(跨天会话不再堆到一天)。
//   后续轮询 = 行级增量:当前累计 - 基线累计 → delta 归到 last_seen 日。基线存 store。
const { localDayStr } = require('../../core/locallog');

const DEFAULT_DB_PATH = () => 'C:\\Users\\BaFeii7\\AppData\\Local\\hermes\\state.db';
const BASELINE_KEY = 'providers.hermes.baseline';
const PREFIX = 'hermes:';

// 行的稳定主键(session+model+task+provider,与 hermes_state.py ON CONFLICT 一致)。
function rowKey(row) {
  return [
    row.session_id,
    row.model || '',
    row.billing_provider || '',
    row.billing_base_url || '',
    row.task || ''
  ].join('|');
}

function rowTokens(row) {
  return {
    input: Number(row.input_tokens) || 0,
    output: Number(row.output_tokens) || 0,
    cached: Number(row.cache_read_tokens) || 0,
    reason: Number(row.reasoning_tokens) || 0,
    total: 0
  };
}

// 读取一行 token 累计(不含 total,调用方自行组合)。
function readRows(db) {
  const rows = db.prepare(`
    SELECT session_id, model, billing_provider, billing_base_url, billing_mode, task,
           api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen
    FROM session_model_usage
  `).all();
  return rows.map((r) => {
    const t = {
      input: Number(r.input_tokens) || 0,
      cached: Number(r.cache_read_tokens) || 0,
      output: Number(r.output_tokens) || 0,
      reasoning: Number(r.reasoning_tokens) || 0
    };
    t.total = t.input + t.cached + t.output + t.reasoning;
    return Object.assign({}, r, {
      calls: Number(r.api_call_count) || 0,
      cost: Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0,
      tokens: t,
      firstDay: localDayStr(Number(r.first_seen) * 1000),
      lastDay: localDayStr(Number(r.last_seen) * 1000)
    });
  });
}

// 按会话取 messages 每日 assistant 消息数(用于历史比例拆分)。
// 返回 { [day]: count }。
function dailyMessageCounts(db, sessionId, role) {
  const roleSql = role || 'assistant';
  const rows = db.prepare(`
    SELECT date(timestamp, 'unixepoch', 'localtime') AS d, COUNT(*) AS c
    FROM messages WHERE session_id = ? AND role = ?
    GROUP BY d
  `).all(sessionId, roleSql);
  const out = {};
  rows.forEach((r) => { out[r.d] = Number(r.c) || 0; });
  return out;
}

// 把一行累计量按会话每日消息数比例拆到各日。
// 返回 { [day]: { input, cached, output, reasoning, total, calls, cost, messages } }。
function splitByMessages(row, msgCounts) {
  const days = Object.keys(msgCounts)
    .filter((d) => d >= row.firstDay && d <= row.lastDay)
    .sort();
  if (!days.length) return {};
  const totalMsgs = days.reduce((s, d) => s + (Number(msgCounts[d]) || 0), 0);
  if (!totalMsgs) return {};
  const calls = row.calls || Math.max(1, days.length);
  const out = {};
  days.forEach((d) => {
    const ratio = (Number(msgCounts[d]) || 0) / totalMsgs;
    const alloc = (v) => Math.round((Number(v) || 0) * ratio);
    out[d] = {
      input: alloc(row.tokens.input),
      cached: alloc(row.tokens.cached),
      output: alloc(row.tokens.output),
      reasoning: alloc(row.tokens.reasoning),
      total: alloc(row.tokens.total),
      calls: Math.max(0, Math.round(calls * ratio)),
      cost: alloc(Math.round((row.cost || 0) * 100)) / 100
    };
  });
  return out;
}

function mergeEntry(target, add) {
  const cur = target || { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} };
  cur.input += add.input || 0;
  cur.cached += add.cached || 0;
  cur.output += add.output || 0;
  cur.total += add.total || 0;
  cur.cost += add.cost || 0;
  cur.messages += add.messages || add.calls || 0;
  return cur;
}

// 每日聚合写入 usageDaily['hermes:YYYY-MM-DD'],保留 models 分布。
function rollup(entries, model) {
  const dayEntries = {};
  Object.keys(entries).forEach((day) => {
    dayEntries[day] = entries[day];
  });
  return dayEntries;
}

// 读 state.db 并做行级增量合并。store 为空时做一次性历史导入。
// 返回 { imported, deltaApplied };失败抛错由调用方处理。
function readHermesUsage(store, dbPath, logger) {
  const log = logger || console;
  let DatabaseSync = null;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    throw new Error('node:sqlite unavailable');
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    throw new Error('无法打开 hermes state.db: ' + (e.message || e));
  }
  try {
    const rows = readRows(db);
    const usageDaily = (store && store.get('usageDaily')) || {};
    const baseline = (store && store.get(BASELINE_KEY)) || {};
    const newBaseline = {};
    const daily = {}; // day -> { input,cached,output,total,cost,messages }

    rows.forEach((row) => {
      const key = rowKey(row);
      const prev = baseline[key];
      const model = row.model || 'unknown';
      // 去掉 provider 前缀的短模型名,如 xiaomi/mimo-v2.5 → mimo-v2.5
      const shortModel = String(model).split('/').pop() || model;

      // 首次接入(无基线):全量历史,按消息比例拆多日
      if (!prev) {
        const counts = dailyMessageCounts(db, row.session_id);
        const split = splitByMessages(row, counts);
        Object.keys(split).forEach((day) => {
          const add = split[day];
          if (add.total <= 0 && add.cost <= 0) return;
          const entry = daily[day] || (daily[day] = { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} });
          entry.input += add.input;
          entry.cached += add.cached;
          entry.output += add.output;
          entry.total += add.total;
          entry.cost += add.cost;
          entry.messages += add.calls || (add.total > 0 ? 1 : 0);
          const m = entry.models[shortModel] || { tokens: 0, cost: 0, messages: 0 };
          m.tokens += add.total;
          m.cost += add.cost;
          m.messages += add.calls || (add.total > 0 ? 1 : 0);
          entry.models[shortModel] = m;
        });
      } else {
        // 后续增量:delta = 当前 - 基线,归到 last_seen 日
        const delta = {
          input: row.tokens.input - (Number(prev.input) || 0),
          cached: row.tokens.cached - (Number(prev.cached) || 0),
          output: row.tokens.output - (Number(prev.output) || 0),
          reasoning: row.tokens.reasoning - (Number(prev.reasoning) || 0),
          cost: row.cost - (Number(prev.cost) || 0)
        };
        delta.total = delta.input + delta.cached + delta.output + delta.reasoning;
        if (delta.total > 0 || delta.cost !== 0) {
          const day = row.lastDay;
          const entry = daily[day] || (daily[day] = { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} });
          entry.input += Math.max(0, delta.input);
          entry.cached += Math.max(0, delta.cached);
          entry.output += Math.max(0, delta.output);
          entry.total += Math.max(0, delta.total);
          entry.cost += delta.cost;
          entry.messages += Math.max(0, row.calls - (Number(prev.calls) || 0));
          const m = entry.models[shortModel] || { tokens: 0, cost: 0, messages: 0 };
          m.tokens += Math.max(0, delta.total);
          m.cost += delta.cost;
          m.messages += Math.max(0, row.calls - (Number(prev.calls) || 0));
          entry.models[shortModel] = m;
        }
      }

      // 更新基线(始终记录最新累计)
      newBaseline[key] = {
        calls: row.calls,
        input: row.tokens.input,
        cached: row.tokens.cached,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
        cost: row.cost
      };
    });

    // 写入 usageDaily:hermes:* 是增量累计键,不能全量覆盖(否则无 delta 的历史日会被清空)。
    // 首次导入 = 全部键新建;后续轮询 = 各日累加本轮 delta(行级基线保证不重复)。
    Object.keys(daily).forEach((day) => {
      const add = daily[day];
      const prev = usageDaily[PREFIX + day] || { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} };
      const models = Object.assign({}, prev.models || {});
      Object.keys(add.models).forEach((name) => {
        const m = models[name] || { tokens: 0, cost: 0, messages: 0 };
        m.tokens += add.models[name].tokens;
        m.cost += add.models[name].cost;
        m.messages += add.models[name].messages;
        models[name] = m;
      });
      usageDaily[PREFIX + day] = {
        input: (prev.input || 0) + add.input,
        cached: (prev.cached || 0) + add.cached,
        output: (prev.output || 0) + add.output,
        total: (prev.total || 0) + add.total,
        cost: Math.round(((prev.cost || 0) + add.cost) * 100) / 100,
        messages: (prev.messages || 0) + add.messages,
        models: Object.keys(models).map((name) => Object.assign({ model: name }, models[name]))
          .sort((a, b) => b.tokens - a.tokens)
      };
    });
    if (store) {
      store.set('usageDaily', usageDaily);
      store.set(BASELINE_KEY, newBaseline);
    }
    return { rows: rows.length, days: Object.keys(daily).length };
  } catch (e) {
    log.error('[hermes] read error:', e && e.message ? e.message : e);
    throw e;
  } finally {
    try { db.close(); } catch (e) {}
  }
}

// 从 store 读 hermes 聚合,返回卡片数据 { today, total }。
function getStats(ctx) {
  const store = ctx && ctx.store;
  const usageDaily = (store && store.get('usageDaily')) || {};
  const todayStr = localDayStr(Date.now());
  const today = { date: todayStr, tokens: 0, cost: 0, messages: 0, models: [] };
  const total = { tokens: 0, cost: 0, messages: 0, days: 0 };
  Object.keys(usageDaily).forEach((key) => {
    if (key.indexOf(PREFIX) !== 0) return;
    const date = key.slice(PREFIX.length);
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
  readHermesUsage,
  getStats,
  rowKey,
  rowTokens,
  dailyMessageCounts,
  splitByMessages,
  DEFAULT_DB_PATH,
  BASELINE_KEY
};
