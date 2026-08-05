const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQuota, buildHeaders, fetchQuota, LIMITS } = require('../src/main/providers/opencode-go/quota');
const { extractWorkspace } = require('../src/main/providers/opencode-go/auth');

// 与 console core lite-section queryLiteSubscription 返回结构一致的样本
function sampleResponse(overrides) {
  return Object.assign({
    mine: true,
    useBalance: false,
    region: ['us', 'eu', 'sg'],
    rollingUsage: { status: 'ok', resetInSec: 7200, usagePercent: 45 },
    weeklyUsage: { status: 'ok', resetInSec: 86400 * 3, usagePercent: 20 },
    monthlyUsage: { status: 'ok', resetInSec: 86400 * 12, usagePercent: 50 }
  }, overrides);
}

test('parseQuota maps percent windows into 5h/weekly/monthly quota windows', () => {
  const quota = parseQuota(sampleResponse());
  assert.ok(quota);
  assert.equal(quota.provider, 'opencode-go');
  assert.equal(quota.billingMode, 'subscription');
  assert.equal(quota.planName, 'OpenCode Go');
  assert.equal(quota.windows.length, 3);

  const byKind = {};
  quota.windows.forEach((w) => { byKind[w.kind] = w; });

  // 5h:$12 → 45% = $5.40
  assert.equal(byKind['5h'].kind, '5h');
  assert.equal(byKind['5h'].used, 12 * 0.45);
  assert.equal(byKind['5h'].limit, LIMITS.rolling);
  assert.equal(byKind['5h'].remaining, 12 - 12 * 0.45);

  // weekly:$30 → 20% = $6.00
  assert.equal(byKind.weekly.used, 30 * 0.20);
  assert.equal(byKind.weekly.limit, LIMITS.weekly);

  // monthly:$60 → 50% = $30.00
  assert.equal(byKind.monthly.used, 60 * 0.50);
  assert.equal(byKind.monthly.limit, LIMITS.monthly);

  // resetsAt = now + resetInSec*1000(容差 1s)
  assert.ok(Math.abs(byKind['5h'].resetsAt - (Date.now() + 7200 * 1000)) < 1000);
  assert.ok(Math.abs(byKind.weekly.resetsAt - (Date.now() + 86400 * 3 * 1000)) < 1000);
});

test('parseQuota accepts the { result } server-function wrapper and clamps percent', () => {
  const wrapped = parseQuota({ result: sampleResponse({ rollingUsage: { status: 'ok', resetInSec: 0, usagePercent: 150 } }) });
  assert.ok(wrapped);
  assert.equal(wrapped.windows[0].kind, '5h');
  assert.equal(wrapped.windows[0].used, LIMITS.rolling);
  assert.equal(wrapped.windows[0].remaining, 0);

  const negative = parseQuota(sampleResponse({ rollingUsage: { status: 'ok', resetInSec: 60, usagePercent: -5 } }));
  assert.equal(negative.windows[0].used, 0);
});

test('parseQuota returns null for empty or unusable payloads', () => {
  assert.equal(parseQuota(null), null);
  assert.equal(parseQuota({}), null);
  assert.equal(parseQuota({ result: {} }), null);
});

test('buildHeaders merges captured origin/referer/UA with cookie', () => {
  const headers = buildHeaders({
    cookie: 'session=abc',
    headers: { origin: 'https://opencode.ai', referer: 'https://opencode.ai/workspace/x/go', 'user-agent': 'Mozilla' }
  });
  assert.equal(headers['Cookie'], 'session=abc');
  assert.equal(headers.origin, 'https://opencode.ai');
  assert.equal(headers.referer, 'https://opencode.ai/workspace/x/go');
  assert.equal(headers['user-agent'], 'Mozilla');
});

test('fetchQuota returns null without captured credentials', async () => {
  const store = { get() { return null; }, set() {}, delete() {} };
  const ctx = { store, httpPostJson: async () => { throw new Error('should not call'); }, getProxyUrl: () => null };
  assert.equal(await fetchQuota(ctx), null);
});

test('fetchQuota replays the captured _server request with the stored cookie', async () => {
  const requestBody = JSON.stringify({ name: 'lite.subscription.get', args: ['ws_123'] });
  const captured = {
    url: 'https://opencode.ai/_server',
    cookie: 'session=xyz',
    requestBody,
    headers: { origin: 'https://opencode.ai', referer: 'https://opencode.ai/workspace/ws_123/go', 'user-agent': 'UA' },
    capturedAt: Date.now()
  };
  let posted = null;
  const store = {
    get(k) { return k === 'providers.opencode-go.session' ? captured : null; },
    set() {}, delete() {}
  };
  const ctx = {
    store,
    httpPostJson: async (url, body, headers, proxyUrl) => {
      posted = { url, body, headers, proxyUrl };
      return { result: sampleResponse() };
    },
    getProxyUrl: () => 'http://127.0.0.1:7890'
  };

  const quota = await fetchQuota(ctx);
  assert.ok(quota);
  assert.equal(posted.url, 'https://opencode.ai/_server');
  assert.deepEqual(posted.body, { name: 'lite.subscription.get', args: ['ws_123'] });
  assert.equal(posted.headers['Cookie'], 'session=xyz');
  assert.equal(posted.headers.origin, 'https://opencode.ai');
  assert.equal(posted.proxyUrl, 'http://127.0.0.1:7890');
});

test('extractWorkspace reads the workspace id from the captured request body', () => {
  assert.equal(extractWorkspace('{"name":"lite.subscription.get","args":["ws_42"]}'), 'ws_42');
  assert.equal(extractWorkspace('{"args":[]}'), null);
  assert.equal(extractWorkspace('not json'), null);
});
