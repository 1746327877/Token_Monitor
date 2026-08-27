const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScrapedUsage, parseScrapedStats, parsePercent, parseResetSeconds, LIMITS } = require('../src/main/providers/command-goat/quota');
const { saveStats } = require('../src/main/providers/command-goat/auth');
const { localDayStr } = require('../src/main/core/locallog');

function makeStore() {
  const data = {};
  return {
    data,
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
}

test('parsePercent reads percentage text', () => {
  assert.equal(parsePercent('32%'), 32);
  assert.equal(parsePercent('5-hour ███ 32% · resets in 3h 12m'), 32);
  assert.equal(parsePercent('无数据'), null);
  // 超过 100% 钳制到 100
  assert.equal(parsePercent('150%'), 100);
});

test('parseResetSeconds handles cli and zh/en formats', () => {
  assert.equal(parseResetSeconds('resets in 3h 12m'), 3 * 3600 + 12 * 60);
  assert.equal(parseResetSeconds('resets in 2d 4h'), 2 * 86400 + 4 * 3600);
  assert.equal(parseResetSeconds('重置时间: 3 小时 12 分钟'), 3 * 3600 + 12 * 60);
  assert.equal(parseResetSeconds('重置于 2 天 4 小时'), 2 * 86400 + 4 * 3600);
  assert.equal(parseResetSeconds('resets in 90m'), 90 * 60);
  assert.equal(parseResetSeconds(''), 0);
});

test('parseResetSeconds handles absolute times', () => {
  const now = new Date(2026, 7, 18, 10, 0, 0).getTime(); // 2026-08-18 10:00
  // 当天 3:00 PM = 15:00 → 5 小时后
  assert.equal(parseResetSeconds('resets at 3:00 PM', now), 5 * 3600);
  // 已过时刻(09:00)→ 明天 09:00
  assert.equal(parseResetSeconds('resets at 9:00 AM', now), 23 * 3600);
  // 完整日期时间
  assert.equal(parseResetSeconds('resets on 2026-08-20 12:00', now), 2 * 86400 + 2 * 3600);
});

test('parseResetSeconds ignores dates not tied to a reset keyword', () => {
  const now = new Date(2026, 7, 18, 10, 0, 0).getTime();
  // 块里混入的账单周期日期,没有 reset/重置 关键词 → 不解析
  assert.equal(parseResetSeconds('Weekly usage billing cycle 2026-10-19 07:02 next payment', now), 0);
  // 重置关键词后面的才是正确时间
  assert.equal(parseResetSeconds('Weekly usage resets on 2026-08-20 12:00 billing 2026-10-19', now), 2 * 86400 + 2 * 3600);
});

test('parseResetSeconds only takes the first duration cluster (ignores filter labels)', () => {
  const now = new Date(2026, 7, 18, 10, 0, 0).getTime();
  // 页面真实文本:后面的 "Last 30 days" 等筛选按钮不得累加
  const weekly = 'WEEKLY LIMIT 23% $8.10 of $35 · resets in 5d 19h // Usage Over Time Last 5 min Last hour Last 6 hours Last 12 hours Last 24 hours Last 3 days Last 7 days Last 14 days Last 30 days';
  assert.equal(parseResetSeconds(weekly, now), 5 * 86400 + 19 * 3600);
  const fiveHour = '5-HOUR LIMIT 13% $1.84 of $14 · resets in 2h 22m';
  assert.equal(parseResetSeconds(fiveHour, now), 2 * 3600 + 22 * 60);
});

test('parseResetSeconds handles month-name reset dates (Sep 17)', () => {
  const now = new Date(2026, 7, 18, 10, 0, 0).getTime(); // 2026-08-18
  // 页面真实文本:月度 "resets Sep 17" → 2026-09-17(30 天后)
  const monthly = 'used this month $8.10 of $70 used this month · resets Sep 17 12% Free on Laguna S 2.1';
  const secs = parseResetSeconds(monthly, now);
  assert.equal(secs, Math.round((new Date(2026, 8, 17).getTime() - now) / 1000));
  // 中文月日
  const zh = '重置于 9月17日';
  assert.equal(parseResetSeconds(zh, now), Math.round((new Date(2026, 8, 17).getTime() - now) / 1000));
});

test('parseScrapedUsage maps 5-hour and weekly meters into quota windows', () => {
  const items = [
    '5-hour ███░░░░░░░ 32% · resets in 3h 12m',
    'Weekly ████░░░░░░ 41% · resets in 2d 4h'
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.provider, 'command-goat');
  assert.equal(quota.billingMode, 'subscription');
  assert.equal(quota.planName, 'Command Goat');
  assert.equal(quota.windows.length, 2);

  const byKind = {};
  quota.windows.forEach((w) => { byKind[w.kind] = w; });

  // 5h:$14 → 32% = $4.48
  assert.equal(byKind['5h'].used, LIMITS.rolling * 0.32);
  assert.equal(byKind['5h'].limit, LIMITS.rolling);
  assert.ok(Math.abs(byKind['5h'].resetsAt - (Date.now() + (3 * 3600 + 12 * 60) * 1000)) < 1000);
  // weekly:$35 → 41% = $14.35
  assert.equal(byKind.weekly.used, LIMITS.weekly * 0.41);
  assert.equal(byKind.weekly.limit, LIMITS.weekly);
  assert.ok(Math.abs(byKind.weekly.resetsAt - (Date.now() + (2 * 86400 + 4 * 3600) * 1000)) < 1000);
});

test('parseScrapedUsage accepts zh labels and clamps percent', () => {
  const items = [
    '5 小时用量 150%',
    '本周用量 20%'
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.windows[0].used, LIMITS.rolling);
  assert.equal(quota.windows[0].remaining, 0);
  assert.equal(quota.windows[1].kind, 'weekly');
});

test('parseScrapedUsage returns null when nothing matches', () => {
  assert.equal(parseScrapedUsage(null), null);
  assert.equal(parseScrapedUsage([]), null);
  assert.equal(parseScrapedUsage(['没有任何用量数据']), null);
  assert.equal(parseScrapedUsage(['Something 32%']), null);
});

test('parseScrapedUsage captures the monthly credit pool from the Studio overview', () => {
  const items = [
    'MONTHLY USAGE $0.12 of $70 used this month'
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.windows.length, 1);
  const monthly = quota.windows[0];
  assert.equal(monthly.kind, 'monthly');
  assert.equal(monthly.used, 0.12);
  assert.equal(monthly.limit, 70);
  assert.equal(monthly.remaining, 70 - 0.12);
  assert.equal(monthly.resetsAt, null);
});

test('parseResetSeconds ignores token counts like 999.9M after the reset keyword', () => {
  const now = new Date(2026, 7, 18, 10, 0, 0).getTime();
  // 页面真实文本:重置词后面跟着 "Sep 17" 和 "999.9M tokens" —
  // "9M" 不得被误读成 9 分钟,应解析月名日期 Sep 17
  const monthly = 'MONTHLY USAGE 40% of monthly limit used · resets Sep 17 TOTAL TOKENS 999.9M tokens TOTAL RUNS 3345 runs';
  const secs = parseResetSeconds(monthly, now);
  assert.equal(secs, Math.round((new Date(2026, 8, 17).getTime() - now) / 1000));
});

test('parseScrapedUsage dedupes duplicate windows (same kind matched multiple times)', () => {
  // 页面里同一窗口可能被多处匹配:monthly 出现在概览 + 使用页,5h 也可能出现两次
  const items = [
    'MONTHLY USAGE $10 of $70 used this month',
    'Monthly $9.50 of $70',
    '5-hour usage $4 of $14 · resets in 3h',
    '5-hour ███ 30%',
    'Weekly $14 of $35 · resets in 2d',
    'Weekly usage'
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  // 每种窗口只保留一条
  assert.equal(quota.windows.length, 3);
  const kinds = quota.windows.map((w) => w.kind);
  assert.deepEqual(kinds, ['5h', 'weekly', 'monthly']); // 固定顺序
  const byKind = {};
  quota.windows.forEach((w) => { byKind[w.kind] = w; });
  // 保留信息更全的一条(有金额/有重置时间的)
  assert.equal(byKind['5h'].used, 4);
  assert.equal(byKind['5h'].limit, 14);
  assert.equal(byKind.monthly.used, 10);
});

test('parseScrapedUsage handles dollar-format 5h/weekly windows (usage page)', () => {
  const items = [
    '5-hour usage $4.48 of $14 · resets in 3h 12m',
    'Weekly usage $14.35 of $35 · resets in 2d 4h'
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.windows.length, 2);
  const byKind = {};
  quota.windows.forEach((w) => { byKind[w.kind] = w; });
  assert.equal(byKind['5h'].used, 4.48);
  assert.equal(byKind['5h'].limit, 14);
  assert.equal(byKind['5h'].remaining, 14 - 4.48);
  assert.ok(Math.abs(byKind['5h'].resetsAt - (Date.now() + (3 * 3600 + 12 * 60) * 1000)) < 1000);
  assert.equal(byKind.weekly.used, 14.35);
  assert.equal(byKind.weekly.limit, 35);
  assert.ok(Math.abs(byKind.weekly.resetsAt - (Date.now() + (2 * 86400 + 4 * 3600) * 1000)) < 1000);
});

test('parseScrapedStats extracts tokens/runs/cost from the Studio overview', () => {
  const items = [
    'MONTHLY USAGE $0.12 of $70 used this month',
    'TOTAL TOKENS 471.4K tokens',
    'TOTAL RUNS 1 runs'
  ];
  const stats = parseScrapedStats(items);
  assert.equal(stats.tokens, 471400);
  assert.equal(stats.runs, 1);
  assert.equal(stats.cost, 0.12);

  const million = parseScrapedStats(['TOTAL TOKENS 12.5M tokens']);
  assert.equal(million.tokens, 12500000);
  const none = parseScrapedStats([]);
  assert.equal(none.tokens, 0);
  assert.equal(none.runs, 0);
});

test('parseScrapedStats estimates cost from the monthly percent when no dollar amount', () => {
  // 新概览页格式: MONTHLY USAGE 34% of monthly limit used
  const items = ['MONTHLY USAGE 34% of monthly limit used · resets Sep 17 TOTAL TOKENS 826.8M tokens TOTAL RUNS 2738 runs'];
  const stats = parseScrapedStats(items);
  assert.equal(stats.tokens, 826800000);
  assert.equal(stats.runs, 2738);
  assert.equal(stats.cost, Math.round(70 * 0.34 * 100) / 100); // $23.8
});

test('saveStats fills command-goat daily usage from opencode.db commandcode messages', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { DatabaseSync } = require('node:sqlite');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-goat-db-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');

  const today = localDayStr(Date.now());
  const prev = localDayStr(Date.now() - 86400000);
  const msg = (completed, pid, input, output, reason, cacheRead, cost) => JSON.stringify({
    role: 'assistant',
    providerID: pid,
    modelID: 'deepseek/deepseek-v4-flash',
    cost,
    tokens: { input, output, reasoning: reason, cache: { read: cacheRead, write: 0 } },
    time: { created: completed, completed }
  });
  const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const dayMs = 86400000;
  ins.run('m1', 's', Date.now(), Date.now(), msg(Date.now(), 'commandcode', 100, 50, 10, 200, 0.01));
  ins.run('m2', 's', Date.now(), Date.now(), msg(Date.now(), 'command-code', 300, 60, 20, 400, 0.02));
  ins.run('m3', 's', Date.now() - dayMs, Date.now(), msg(Date.now() - dayMs, 'commandcode', 1000, 100, 0, 500, 0.05));
  // 非 cmd provider 不得计入
  ins.run('m4', 's', Date.now(), Date.now(), msg(Date.now(), 'opencode-go', 999, 999, 0, 0, 9));
  db.close();

  const store = makeStore();
  store.set('providers.opencode.dbPath', dbPath);
  saveStats(store, ['x']);
  saveStats(store, ['y']); // 全量重算,不重复累加

  const ud = store.get('usageDaily');
  // 今天:两条 cmd 消息合计 input100+300 + cached200+400 + output50+60 + reason10+20 = 1140
  assert.equal(ud['command-goat:' + today].total, 1140);
  assert.equal(ud['command-goat:' + today].cost, 0.01 + 0.02);
  assert.equal(ud['command-goat:' + today].messages, 2);
  // 昨天:1000+100+500 = 1600
  assert.equal(ud['command-goat:' + prev].total, 1600);
  // opencode-go 消息不计入 command-goat
  assert.ok(!Object.keys(ud).some((k) => k.indexOf('command-goat') === 0 && ud[k].total > 2000));
  // 本月统计 = 今天(昨天若跨月不计,此处同月则两笔都算)
  const stats = store.get('providers.command-goat.stats');
  assert.ok(stats.tokens >= 1140);

  fs.rmSync(dir, { recursive: true, force: true });
});
