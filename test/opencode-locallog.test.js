const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseMessageFile,
  parseMessageData,
  scanMessageFiles,
  readLocalLog,
  getStats
} = require('../src/main/providers/opencode/locallog');

function makeMessage(overrides) {
  return Object.assign({
    id: 'msg_abc123',
    sessionID: 'ses_xyz',
    role: 'assistant',
    time: { created: 1783306059300, completed: 1783306062600 },
    modelID: 'deepseek-v4-flash',
    cost: 0.00183232,
    tokens: { input: 12828, output: 98, reasoning: 32, cache: { read: 500, write: 0 } },
    finish: 'tool-calls'
  }, overrides);
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-opencode-'));
}

function makeCursorStore() {
  const data = {};
  return {
    data,
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
}

test('parseMessageFile maps opencode tokens including reasoning into output', () => {
  const rec = parseMessageFile(JSON.stringify(makeMessage(), null, 2));
  assert.ok(rec);
  assert.equal(rec.id, 'msg_abc123');
  assert.equal(rec.ts, 1783306062600);
  assert.equal(rec.model, 'deepseek-v4-flash');
  assert.equal(rec.cost, 0.00183232);
  // input 不含缓存;output 叠加 reasoning;total = input + cached + output
  assert.equal(rec.usage.input, 12828);
  assert.equal(rec.usage.cached, 500);
  assert.equal(rec.usage.output, 98 + 32);
  assert.equal(rec.usage.total, 12828 + 500 + 98 + 32);
});

test('parseMessageData handles the SQLite data field (tokens.total present, id separate)', () => {
  const row = {
    id: 'msg_sq1',
    time_created: 1785917860034,
    data: JSON.stringify(makeMessage({
      id: undefined,
      tokens: { total: 433597, input: 613, output: 156, reasoning: 316, cache: { write: 0, read: 432512 } }
    }))
  };
  const rec = parseMessageData(JSON.parse(row.data), row.id);
  assert.ok(rec);
  assert.equal(rec.id, 'msg_sq1');
  // total 直接取自 tokens.total(含缓存读取 + reasoning)
  assert.equal(rec.usage.total, 433597);
  assert.equal(rec.usage.input, 613);
  assert.equal(rec.usage.cached, 432512);
  assert.equal(rec.usage.output, 156 + 316);

  // 未完成(无 time.completed)不计数
  const pending = parseMessageData(makeMessage({ time: { created: 1 } }), 'msg_sq2');
  assert.equal(pending, null);
  // 非 assistant 不计
  assert.equal(parseMessageData(makeMessage({ role: 'user' }), 'msg_sq3'), null);
});

test('parseMessageFile returns null for non-json / non-assistant / incomplete / missing tokens', () => {
  assert.equal(parseMessageFile('not json'), null);
  assert.equal(parseMessageFile(''), null);
  assert.equal(parseMessageFile(JSON.stringify(makeMessage({ role: 'user' }))), null);
  assert.equal(parseMessageFile(JSON.stringify(makeMessage({ tokens: undefined }))), null);
  assert.equal(parseMessageFile(JSON.stringify(makeMessage({ time: { created: 1 } }))), null);
});

test('scanMessageFiles counts a new message exactly once across rescans', () => {
  const dir = makeTempDir();
  const sessionDir = path.join(dir, 'ses_a');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'msg_1.json');
  const cursorStore = makeCursorStore();
  try {
    fs.writeFileSync(file, JSON.stringify(makeMessage({ id: 'msg_1' }), null, 2));
    const first = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'msg_1');

    // 未变化:再次扫描不重复计数
    const unchanged = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(unchanged.length, 0);

    // 已计入文件即使被改写(理论上 completed 后不再变)也不重复计数
    fs.writeFileSync(file, JSON.stringify(makeMessage({ id: 'msg_1', cost: 9 }), null, 2));
    const rewritten = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(rewritten.length, 0);

    // 新增第二个消息:只返回新增
    const file2 = path.join(sessionDir, 'msg_2.json');
    fs.writeFileSync(file2, JSON.stringify(makeMessage({ id: 'msg_2' }), null, 2));
    const second = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].id, 'msg_2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanMessageFiles counts a message only after it completes', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'msg_pending.json');
  const cursorStore = makeCursorStore();
  try {
    // 流式中的消息:无 time.completed,不计数
    fs.writeFileSync(file, JSON.stringify(makeMessage({ time: { created: 1783306059300 } }), null, 2));
    const first = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(first.length, 0);

    // 消息完成后文件变化:重新读取并计数一次
    fs.writeFileSync(file, JSON.stringify(makeMessage({ id: 'msg_pending' }), null, 2));
    const second = scanMessageFiles({
      root: dir, match: /\.json$/, cursorStore, cursorKey: 'c', parseFile: parseMessageFile
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].id, 'msg_pending');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocalLog merges incremental daily rollup into store usageDaily', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'msg_rollup.json');
  const data = {};
  const store = {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
  try {
    store.set('providers.opencode.localLogRoot', dir);
    const now = Date.now();
    const firstMsg = makeMessage({ id: 'msg_a', time: { created: now, completed: now }, cost: 0.1, tokens: { input: 1000, output: 200, reasoning: 100, cache: { read: 50, write: 0 } } });
    const secondMsg = makeMessage({ id: 'msg_b', time: { created: now + 1000, completed: now + 1000 }, cost: 0.2, tokens: { input: 2000, output: 300, reasoning: 0, cache: { read: 100, write: 0 } } });
    fs.writeFileSync(file, JSON.stringify(firstMsg, null, 2));

    const first = readLocalLog({ store });
    assert.equal(first.length, 1);

    // 第二个消息追加到另一文件:增量合并,usageDaily 累加
    fs.writeFileSync(path.join(dir, 'msg_rollup2.json'), JSON.stringify(secondMsg, null, 2));
    const second = readLocalLog({ store });
    assert.equal(second.length, 1);

    const { localDayStr } = require('../src/main/core/locallog');
    const day = localDayStr(now);
    const agg = store.get('usageDaily')['opencode:' + day];
    assert.equal(agg.input, 1000 + 2000);
    assert.equal(agg.cached, 50 + 100);
    assert.equal(agg.output, (200 + 100) + 300);
    assert.equal(agg.total, (1000 + 50 + 200 + 100) + (2000 + 100 + 300));
    assert.equal(agg.cost, 0.1 + 0.2);
    assert.equal(agg.messages, 2);
    assert.equal(agg.models.length, 1);
    assert.equal(agg.models[0].model, 'deepseek-v4-flash');
    assert.equal(agg.models[0].tokens, agg.total);

    // 无新增时返回空,聚合不重复累加
    assert.equal(readLocalLog({ store }).length, 0);
    assert.equal(store.get('usageDaily')['opencode:' + day].cost, 0.1 + 0.2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStats returns today and total aggregates from usageDaily', () => {
  const data = {};
  const store = {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
  const today = new Date().toISOString().slice(0, 10);
  data['usageDaily'] = {
    ['opencode:' + today]: { input: 10, cached: 2, output: 3, total: 15, cost: 0.05, messages: 4, models: [{ model: 'm1', tokens: 15, cost: 0.05, messages: 4 }] },
    'opencode:2026-01-01': { input: 5, cached: 0, output: 1, total: 6, cost: 0.02, messages: 2, models: [] },
    'codex:2026-01-02': { input: 99, cached: 0, output: 1, total: 100, cost: 9, messages: 1, models: [] }
  };

  const stats = getStats({ store });
  assert.equal(stats.today.date, today);
  assert.equal(stats.today.tokens, 15);
  assert.equal(stats.today.cost, 0.05);
  assert.equal(stats.today.messages, 4);
  assert.equal(stats.today.models.length, 1);
  assert.equal(stats.total.tokens, 15 + 6);
  assert.equal(stats.total.cost, 0.05 + 0.02);
  assert.equal(stats.total.messages, 4 + 2);
  assert.equal(stats.total.days, 2);
});
