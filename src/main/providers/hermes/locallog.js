// Hermes 本地用量读取。
// 数据源:C:\Users\BaFeii7\AppData\Local\hermes\state.db(SQLite)
//   session_model_usage 表:每行 = session+model+task 的累计量,行随会话增长
//     (ON CONFLICT 累加,last_seen 更新,first_seen 固定)。
//   messages 表:每消息 timestamp + role(无 token),用于把跨天会话的累计量按日拆分。
// 策略:**全量重算**(幂等,不依赖跨轮基线):
//   每次轮询读全部行,把每行累计量按该会话 messages 的每日 assistant 消息数比例
//   拆到 first_seen..last_seen 之间的日期;会话无 assistant 消息时整行归 last_seen 日。
//   然后**覆盖**写入 usageDaily['hermes:...']。这样无论运行多少轮,某天的值都只由
//   DB 当前状态决定,绝不会像增量累加那样越滚越大。
const { localDayStr } = require('../../core/locallog');

const DEFAULT_DB_PATH = () => 'C:\\Users\\BaFeii7\\AppData\\Local\\hermes\\state.db';
const PREFIX = 'hermes:';

// 读取一行 token 累计。
function rowTokens(row) {
  const input = Number(row.input_tokens) || 0;
  const cached = Number(row.cache_read_tokens) || 0;
  const output = Number(row.output_tokens) || 0;
  const reasoning = Number(row.reasoning_tokens) || 0;
  return { input: input, cached: cached, output: output, reasoning: reasoning, total: input + cached + output + reasoning };
}

// 读取所有用量行,附上归日信息。
function readRows(db) {
  const rows = db.prepare(`
    SELECT session_id, model, task, api_call_count,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen
    FROM session_model_usage
  `).all();
  return rows.map((r) => Object.assign({}, r, {
    calls: Number(r.api_call_count) || 0,
    cost: Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0,
    tokens: rowTokens(r),
    firstDay: localDayStr(Number(r.first_seen) * 1000),
    lastDay: localDayStr(Number(r.last_seen) * 1000)
  }));
}

// 按会话取 messages 每日 assistant 消息数(用于比例拆分)。
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
// 无可用消息(或全部落在 first..last 之外)时回退:整行归 last_seen 日。
// 返回 { [day]: { input, cached, output, reasoning, total, calls, cost } }。
function splitByMessages(row, msgCounts) {
  const inRange = Object.keys(msgCounts || {})
    .filter((d) => d >= row.firstDay && d <= row.lastDay)
    .sort();
  const totalMsgs = inRange.reduce((s, d) => s + (Number(msgCounts[d]) || 0), 0);

  if (!inRange.length || totalMsgs <= 0) {
    return {
      [row.lastDay]: {
        input: row.tokens.input,
        cached: row.tokens.cached,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
        total: row.tokens.total,
        calls: row.calls,
        cost: row.cost
      }
    };
  }

  const days = inRange;
  const out = {};
  days.forEach((d) => {
    const ratio = (Number(msgCounts[d]) || 0) / totalMsgs;
    const alloc = (v) => Math.round((Number(v) || 0) * ratio);
    const input = alloc(row.tokens.input);
    const cached = alloc(row.tokens.cached);
    const output = alloc(row.tokens.output);
    const reasoning = alloc(row.tokens.reasoning);
    out[d] = {
      input: input,
      cached: cached,
      output: output,
      reasoning: reasoning,
      total: input + cached + output + reasoning,
      calls: Math.round(row.calls * ratio),
      cost: alloc(Math.round((row.cost || 0) * 100)) / 100
    };
  });
  return out;
}

function shortModel(model) {
  const m = String(model || 'unknown');
  return m.split('/').pop() || m;
}

// 全量重算并覆盖写入 usageDaily 的 hermes:* 键。
// 幂等:同一 DB 状态下重复调用结果完全一致。
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
    const daily = {}; // day -> { input,cached,output,total,cost,messages, models:{} }
    const msgCache = {};

    rows.forEach((row) => {
      const model = shortModel(row.model);
      let counts = msgCache[row.session_id];
      if (!counts) {
        counts = dailyMessageCounts(db, row.session_id);
        msgCache[row.session_id] = counts;
      }
      const split = splitByMessages(row, counts);
      Object.keys(split).forEach((day) => {
        const add = split[day];
        if (!add || (add.total <= 0 && add.cost <= 0 && add.calls <= 0)) return;
        const entry = daily[day] || (daily[day] = { input: 0, cached: 0, output: 0, total: 0, cost: 0, messages: 0, models: {} });
        entry.input += add.input;
        entry.cached += add.cached;
        entry.output += add.output;
        entry.total += add.total;
        entry.cost += add.cost;
        entry.messages += add.calls;
        const m = entry.models[model] || { tokens: 0, cost: 0, messages: 0 };
        m.tokens += add.total;
        m.cost += add.cost;
        m.messages += add.calls;
        entry.models[model] = m;
      });
    });

    // 覆盖写入:先删所有 hermes:* 旧键,再写本轮结果(幂等)
    const usageDaily = (store && store.get('usageDaily')) || {};
    Object.keys(usageDaily).forEach((k) => {
      if (k.indexOf(PREFIX) === 0) delete usageDaily[k];
    });
    Object.keys(daily).forEach((day) => {
      const e = daily[day];
      usageDaily[PREFIX + day] = {
        input: e.input,
        cached: e.cached,
        output: e.output,
        total: e.total,
        cost: Math.round(e.cost * 100) / 100,
        messages: e.messages,
        models: Object.keys(e.models)
          .map((name) => ({ model: name, tokens: e.models[name].tokens, cost: e.models[name].cost, messages: e.models[name].messages }))
          .sort((a, b) => b.tokens - a.tokens)
      };
    });
    if (store) store.set('usageDaily', usageDaily);
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
  rowTokens,
  dailyMessageCounts,
  splitByMessages,
  DEFAULT_DB_PATH
};
