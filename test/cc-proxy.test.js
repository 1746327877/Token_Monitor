const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getConfig,
  resolveKeys,
  resolveSlotKeys,
  buildEnv
} = require('../src/main/core/cc-proxy');

function makeStore(data) {
  const state = data || {};
  return {
    get(k) {
      const parts = k.split('.');
      let v = state;
      for (const p of parts) { if (v == null) return undefined; v = v[p]; }
      return v;
    }
  };
}

function withEnv(values, fn) {
  const prev1 = process.env.COMMAND_CODE_API_KEY;
  const prev2 = process.env.COMMAND_CODE_API_KEY_2;
  try {
    if (values.key1 === null) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = values.key1;
    if (values.key2 === null) delete process.env.COMMAND_CODE_API_KEY_2; else process.env.COMMAND_CODE_API_KEY_2 = values.key2;
    return fn();
  } finally {
    if (prev1 === undefined) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = prev1;
    if (prev2 === undefined) delete process.env.COMMAND_CODE_API_KEY_2; else process.env.COMMAND_CODE_API_KEY_2 = prev2;
  }
}

test('getConfig returns defaults when store has nothing', () => {
  const cfg = getConfig(makeStore());
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pythonPath, 'python');
  assert.equal(cfg.scriptPath, 'D:\\code\\tools\\cc-proxy.py');
});

test('getConfig uses store values when present', () => {
  const cfg = getConfig(makeStore({ ccProxy: { enabled: true, pythonPath: 'py', scriptPath: 'x.py' } }));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.pythonPath, 'py');
  assert.equal(cfg.scriptPath, 'x.py');
});

test('resolveSlotKeys binds slot 1 to key1/env and slot 2 to key2/env', () => {
  withEnv({ key1: 'env-1', key2: 'env-2' }, () => {
    // 设置里填了 → 用设置的
    const slots = resolveSlotKeys(makeStore({ ccProxy: { key1: 'store-1', key2: 'store-2' } }));
    assert.deepEqual(slots, [
      { slot: 1, key: 'store-1' },
      { slot: 2, key: 'store-2' }
    ]);
  });
});

test('resolveSlotKeys falls back to same-name env vars when store key is empty', () => {
  withEnv({ key1: 'env-1', key2: 'env-2' }, () => {
    const slots = resolveSlotKeys(makeStore({ ccProxy: { key1: '', key2: '  ' } }));
    assert.deepEqual(slots, [
      { slot: 1, key: 'env-1' },
      { slot: 2, key: 'env-2' }
    ]);
  });
});

test('resolveSlotKeys returns null for a slot with neither store nor env key', () => {
  withEnv({ key1: 'env-1', key2: null }, () => {
    const slots = resolveSlotKeys(makeStore({ ccProxy: { key1: '  ', key2: '' } }));
    assert.equal(slots[0].key, 'env-1');
    assert.equal(slots[1].key, null);
  });
});

test('resolveKeys returns valid keys in slot order and dedupes', () => {
  withEnv({ key1: null, key2: null }, () => {
    const keys = resolveKeys(makeStore({ ccProxy: { key1: 'a', key2: 'a' } }));
    assert.deepEqual(keys, ['a']);
  });
});

test('buildEnv sets numbered key vars and removes stale ones', () => {
  withEnv({ key1: null, key2: null }, () => {
    process.env.COMMAND_CODE_API_KEY_3 = 'stale';
    try {
      const env = buildEnv(makeStore({ ccProxy: { key1: 'a', key2: 'b' } }));
      assert.equal(env.COMMAND_CODE_API_KEY, 'a');
      assert.equal(env.COMMAND_CODE_API_KEY_2, 'b');
      assert.equal(env.COMMAND_CODE_API_KEY_3, undefined);
      // 原环境变量保留(Windows 下可能是 PATH 或 Path)
      const hasPath = Object.keys(env).some((k) => k.toLowerCase() === 'path');
      assert.ok(hasPath);
      // 强制 UTF-8,避免脚本 emoji print 在 GBK 控制台崩溃
      assert.equal(env.PYTHONIOENCODING, 'utf-8');
      assert.equal(env.PYTHONUTF8, '1');
    } finally {
      delete process.env.COMMAND_CODE_API_KEY_3;
    }
  });
});
