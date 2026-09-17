const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  readHermesUsage,
  getStats,
  splitByMessages
} = require('../src/main/providers/hermes/locallog');

function makeStore() {
  const data = {};
  return {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
}

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-hermes-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_model_usage (
      session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT,
      billing_mode TEXT, task TEXT, api_call_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL, token_count INTEGER
    );
  `);
  return { db, dbPath, dir };
}

function addUsage(db, row) {
  db.prepare(`INSERT INTO session_model_usage
    (session_id, model, billing_provider, billing_base_url, billing_mode, task,
     api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
     first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.session_id, row.model || 'mimo-v2.5', row.billing_provider || 'commandcode',
    row.billing_base_url || 'https://api.commandcode.ai/provider/v1', row.billing_mode || '',
    row.task || '', row.calls || 1, row.input || 0, row.output || 0, row.cached || 0,
    row.cacheWrite || 0, row.reason || 0, row.estCost || 0, row.cost || 0,
    row.cost_status || null, row.cost_source || null, row.first, row.last
  );
}

function addMessage(db, sessionId, tsSec, role) {
  db.prepare('INSERT INTO messages (session_id, role, timestamp) VALUES (?,?,?)')
    .run(sessionId, role || 'assistant', tsSec);
}

function daySec(y, m, d) {
  return Math.round(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000);
}

test('cross-day session tokens are split across days by message counts', () => {
  const { db, dbPath, dir } = makeDb();
  const sid = 's1';
  // 8/19 有 3 条 assistant,8/20 有 1 条 → 总量 4000 按 3:1 拆
  [19, 19, 19, 20].forEach((d, i) => addMessage(db, sid, daySec(2026, 8, d) + i, 'assistant'));
  addUsage(db, {
    session_id: sid, model: 'mimo-v2.5', input: 1000, output: 1000, cached: 2000,
    first: daySec(2026, 8, 19), last: daySec(2026, 8, 20), calls: 4
  });
  try {
    const store = makeStore();
    readHermesUsage(store, dbPath);
    const ud = store.get('usageDaily');
    const d19 = ud['hermes:2026-08-19'];
    const d20 = ud['hermes:2026-08-20'];
    assert.ok(d19 && d20, 'both days present');
    assert.equal(d19.total, 3000);
    assert.equal(d20.total, 1000);
    assert.equal(d19.models.length, 1);
    assert.equal(d19.models[0].model, 'mimo-v2.5');
    assert.equal(d19.models[0].tokens, 3000);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same-day rows land on that day', () => {
  const { db, dbPath, dir } = makeDb();
  const ts = daySec(2026, 9, 1);
  addMessage(db, 'sA', ts, 'assistant');
  addUsage(db, { session_id: 'sA', model: 'deepseek-v4-flash', input: 500, output: 100, first: ts, last: ts, calls: 2 });
  try {
    const store = makeStore();
    readHermesUsage(store, dbPath);
    const d = store.get('usageDaily')['hermes:2026-09-01'];
    assert.equal(d.total, 600);
    assert.equal(d.messages, 2);
    assert.equal(d.models[0].tokens, 600);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHermesUsage is idempotent - repeated polls never inflate totals (regression)', () => {
  const { db, dbPath, dir } = makeDb();
  const ts1 = daySec(2026, 8, 20);
  const ts2 = daySec(2026, 8, 20) + 3600;
  addMessage(db, 's1', ts1, 'assistant');
  addMessage(db, 's1', ts2, 'assistant');
  addUsage(db, { session_id: 's1', model: 'mimo-v2.5', input: 1_000_000, output: 500_000, cached: 2_000_000, first: ts1, last: ts2, calls: 2 });
  try {
    const store = makeStore();
    readHermesUsage(store, dbPath);
    const first = JSON.stringify(store.get('usageDaily')['hermes:2026-08-20']);
    // 模拟运行 5 轮轮询
    for (let i = 0; i < 5; i++) readHermesUsage(store, dbPath);
    const after = store.get('usageDaily')['hermes:2026-08-20'];
    assert.equal(JSON.stringify(after), first, 'repeated polls must not change the value');
    assert.equal(after.total, 3_500_000, 'total stays exact, no inflation');
    assert.equal(after.models.length, 1, 'models array must not grow');
    assert.equal(after.messages, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple billing_base_url variants for one session are summed, not duplicated per poll', () => {
  const { db, dbPath, dir } = makeDb();
  const ts = daySec(2026, 9, 3);
  addMessage(db, 'sv', ts, 'assistant');
  // 同一 session+model,base_url 带/不带斜杠各一行(hermes 格式变更产生)
  addUsage(db, { session_id: 'sv', model: 'mimo-v2.5', input: 1000, billing_base_url: 'https://opencode.ai/zen/go/v1', first: ts, last: ts });
  addUsage(db, { session_id: 'sv', model: 'mimo-v2.5', input: 2000, billing_base_url: 'https://opencode.ai/zen/go/v1/', first: ts, last: ts });
  try {
    const store = makeStore();
    readHermesUsage(store, dbPath);
    readHermesUsage(store, dbPath);
    const d = store.get('usageDaily')['hermes:2026-09-03'];
    assert.equal(d.total, 3000, 'both variants summed once');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('row without assistant messages falls back to its last_seen day', () => {
  const { db, dbPath, dir } = makeDb();
  const ts = daySec(2026, 9, 5);
  // 只有 user 消息,没有 assistant
  addMessage(db, 'su', ts, 'user');
  addUsage(db, { session_id: 'su', model: 'glm-5.3-flash', input: 700, first: ts, last: ts, calls: 1 });
  try {
    const store = makeStore();
    readHermesUsage(store, dbPath);
    const d = store.get('usageDaily')['hermes:2026-09-05'];
    assert.ok(d, 'fallback day present');
    assert.equal(d.total, 700);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStats aggregates hermes days from usageDaily', () => {
  const data = {};
  const store = { get(k) { return k === 'usageDaily' ? data.usageDaily : undefined; } };
  const today = new Date().toLocaleDateString('sv-SE');
  data.usageDaily = {};
  data.usageDaily['hermes:' + today] = { total: 300, cost: 0, messages: 2, models: [{ model: 'm1', tokens: 300, messages: 2 }] };
  data.usageDaily['hermes:2026-08-01'] = { total: 100, cost: 0, messages: 1, models: [] };
  data.usageDaily['opencode:' + today] = { total: 999, cost: 0, messages: 9, models: [] };
  const stats = getStats({ store });
  assert.equal(stats.today.tokens, 300);
  assert.equal(stats.today.models.length, 1);
  assert.equal(stats.total.tokens, 400);
  assert.equal(stats.total.days, 2);
});

test('missing db throws a readable error', () => {
  const store = makeStore();
  assert.throws(() => readHermesUsage(store, 'Z:/nonexistent/state.db'), /state\.db|打开|ENOENT|no such/i);
});