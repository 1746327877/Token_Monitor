const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScrapedUsage, parsePercent, parseResetSeconds, LIMITS } = require('../src/main/providers/command-goat/quota');

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
  assert.equal(parseResetSeconds('2 天 4 小时'), 2 * 86400 + 4 * 3600);
  assert.equal(parseResetSeconds('90m'), 90 * 60);
  assert.equal(parseResetSeconds(''), 0);
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
