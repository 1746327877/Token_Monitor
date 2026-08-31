const test = require('node:test');
const assert = require('node:assert/strict');

// 只导入不依赖 electron 的纯逻辑部分
const quota = require('../src/main/providers/command-goat/quota');
const { parseScrapedUsage } = quota;

// listAccounts/slotConfig 等依赖 electron,改用静态源码断言其键位设计
const fs = require('node:fs');
const path = require('node:path');
const authSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/providers/command-goat/auth.js'), 'utf8');

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    get(k) {
      const parts = k.split('.');
      let v = data;
      for (const p of parts) { if (v == null) return undefined; v = v[p]; }
      return v;
    },
    set(k, val) {
      const parts = k.split('.');
      let v = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (v[parts[i]] == null) v[parts[i]] = {};
        v = v[parts[i]];
      }
      v[parts[parts.length - 1]] = val;
    }
  };
}

test('dual-account slot design keeps slot 1 on legacy keys and slot 2 namespaced', () => {
  // 号1 沿用旧键(现有登录自动成为号1),号2 独立 partition/键
  assert.match(authSrc, /'1': \{ partition: PARTITION, credKey: CRED_KEY/);
  assert.match(authSrc, /'2': \{ partition: 'persist:commandcode-studio-2'/);
  assert.match(authSrc, /'providers\.command-goat\.session\.2'/);
  assert.match(authSrc, /quotaKey: 'providers\.command-goat\.quota\.1'/);
  assert.match(authSrc, /quotaKey: 'providers\.command-goat\.quota\.2'/);
});

test('readCred/writeCred write to per-slot keys', () => {
  // 通过源码验证 readCred 用 slotConfig(slot).credKey
  assert.match(authSrc, /function readCred\(store, slot\)/);
  assert.match(authSrc, /slotConfig\(slot\)\.credKey/);
  assert.match(authSrc, /function writeCred\(store, slot, cred\)/);
});

test('captureSession and fetchQuota accept a slot parameter', () => {
  assert.match(authSrc, /function captureSession\(ctx, slot\)/);
  assert.match(authSrc, /function fetchQuotaForSlot\(ctx, slot\)/);
  // 登录窗口按 slot 用对应 partition
  assert.match(authSrc, /partition: cfg\.partition/);
});

test('parseScrapedUsage still parses a single account into windows', () => {
  const items = [
    '5-hour LIMIT 32% Resets in 3h 12m',
    'WEEKLY LIMIT 41% Resets in 2d 4h',
    'MONTHLY LIMIT 45% Resets on Sep 17'
  ];
  const q = parseScrapedUsage(items, Date.now());
  assert.ok(q);
  assert.equal(q.provider, 'command-goat');
  assert.equal(q.billingMode, 'subscription');
  assert.ok(Array.isArray(q.windows));
  assert.ok(q.windows.length >= 3);
});
