const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getConfig,
  resolveKeys,
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

test('resolveKeys prefers environment variables, fills with store keys, dedupes', () => {
  const prev1 = process.env.COMMAND_CODE_API_KEY;
  const prev2 = process.env.COMMAND_CODE_API_KEY_2;
  try {
    process.env.COMMAND_CODE_API_KEY = 'env-key-1';
    process.env.COMMAND_CODE_API_KEY_2 = 'env-key-2';
    // store 里的 key 与 env 相同 → 去重;多余的 store key 补充
    const keys = resolveKeys(makeStore({ ccProxy: { key1: 'env-key-1', key2: 'store-key-3' } }));
    assert.deepEqual(keys, ['env-key-1', 'env-key-2', 'store-key-3']);
  } finally {
    if (prev1 === undefined) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = prev1;
    if (prev2 === undefined) delete process.env.COMMAND_CODE_API_KEY_2; else process.env.COMMAND_CODE_API_KEY_2 = prev2;
  }
});

test('resolveKeys trims and skips empties', () => {
  const prev1 = process.env.COMMAND_CODE_API_KEY;
  const prev2 = process.env.COMMAND_CODE_API_KEY_2;
  try {
    delete process.env.COMMAND_CODE_API_KEY;
    delete process.env.COMMAND_CODE_API_KEY_2;
    const keys = resolveKeys(makeStore({ ccProxy: { key1: '  ', key2: ' ok-key ' } }));
    assert.deepEqual(keys, ['ok-key']);
  } finally {
    if (prev1 === undefined) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = prev1;
    if (prev2 === undefined) delete process.env.COMMAND_CODE_API_KEY_2; else process.env.COMMAND_CODE_API_KEY_2 = prev2;
  }
});

test('buildEnv sets numbered key vars and removes stale ones', () => {
  const prev1 = process.env.COMMAND_CODE_API_KEY;
  const prev2 = process.env.COMMAND_CODE_API_KEY_2;
  const prev3 = process.env.COMMAND_CODE_API_KEY_3;
  try {
    delete process.env.COMMAND_CODE_API_KEY;
    delete process.env.COMMAND_CODE_API_KEY_2;
    process.env.COMMAND_CODE_API_KEY_3 = 'stale';
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
    if (prev1 === undefined) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = prev1;
    if (prev2 === undefined) delete process.env.COMMAND_CODE_API_KEY_2; else process.env.COMMAND_CODE_API_KEY_2 = prev2;
    if (prev3 === undefined) delete process.env.COMMAND_CODE_API_KEY_3; else process.env.COMMAND_CODE_API_KEY_3 = prev3;
  }
});
