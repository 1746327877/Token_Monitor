const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScrapedUsage, parseResetSeconds, LIMITS } = require('../src/main/providers/opencode-go/quota');
const { extractWorkspace } = require('../src/main/providers/opencode-go/auth');

test('parseResetSeconds handles zh and en unit text', () => {
  assert.equal(parseResetSeconds('重置时间: 2 小时 5 分钟'), 2 * 3600 + 5 * 60);
  assert.equal(parseResetSeconds('Resets in 2 hours 5 minutes'), 2 * 3600 + 5 * 60);
  assert.equal(parseResetSeconds('重置时间: 1 天 3 小时'), 86400 + 3 * 3600);
  assert.equal(parseResetSeconds('1 day 2 hours'), 86400 + 2 * 3600);
  assert.equal(parseResetSeconds('30 分钟'), 30 * 60);
  assert.equal(parseResetSeconds('5 minutes'), 300);
  assert.equal(parseResetSeconds('几秒'), 0);
  assert.equal(parseResetSeconds('a few seconds'), 0);
  assert.equal(parseResetSeconds(''), 0);
});

test('parseScrapedUsage maps DOM items into 5h/weekly/monthly windows', () => {
  const items = [
    { label: '滚动用量', value: '45%', resetText: '重置时间: 2 小时' },
    { label: '每周用量', value: '20%', resetText: '重置时间: 3 天' },
    { label: '每月用量', value: '50%', resetText: '重置时间: 12 天' }
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.provider, 'opencode-go');
  assert.equal(quota.billingMode, 'subscription');
  assert.equal(quota.planName, 'OpenCode Go');
  assert.equal(quota.windows.length, 3);

  const byKind = {};
  quota.windows.forEach((w) => { byKind[w.kind] = w; });

  assert.equal(byKind['5h'].used, LIMITS.rolling * 0.45);
  assert.equal(byKind['5h'].limit, LIMITS.rolling);
  assert.equal(byKind.weekly.used, LIMITS.weekly * 0.20);
  assert.equal(byKind.monthly.used, LIMITS.monthly * 0.50);
  assert.ok(Math.abs(byKind['5h'].resetsAt - (Date.now() + 2 * 3600 * 1000)) < 1000);
  assert.ok(Math.abs(byKind.weekly.resetsAt - (Date.now() + 3 * 86400 * 1000)) < 1000);
});

test('parseScrapedUsage tolerates en text and clamps percent', () => {
  const items = [
    { value: '150%', resetText: 'Resets in 1 hour' },
    { value: '20%', resetText: 'Resets in 1 day' },
    { value: '50%', resetText: 'Resets in 12 days' }
  ];
  const quota = parseScrapedUsage(items);
  assert.ok(quota);
  assert.equal(quota.windows[0].used, LIMITS.rolling);
  assert.equal(quota.windows[0].remaining, 0);
});

test('parseScrapedUsage returns null when nothing parses, partial when some do', () => {
  assert.equal(parseScrapedUsage(null), null);
  assert.equal(parseScrapedUsage([]), null);
  assert.equal(parseScrapedUsage([{ value: 'nope' }]), null);
  const partial = parseScrapedUsage([{ value: '45%' }, { value: '20%' }]);
  assert.ok(partial);
  assert.equal(partial.windows.length, 2);
});

test('extractWorkspace reads the workspace id from a console url', () => {
  assert.equal(extractWorkspace('https://opencode.ai/workspace/wrk_123/go'), 'wrk_123');
  assert.equal(extractWorkspace('https://opencode.ai/zh/workspace/wrk_abc/go'), 'wrk_abc');
  assert.equal(extractWorkspace('https://opencode.ai/auth'), null);
});
