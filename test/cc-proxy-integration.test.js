const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('main process starts and stops the cc-proxy alongside the app lifecycle', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  assert.match(main, /ccProxy\.start\(store, console\)/);
  assert.match(main, /ccProxy\.stop\(\)/);
  // 设置变化时重启
  assert.match(main, /ccProxy\.restartIfNeeded\(store, console\)/);
});

test('settings definitions register the Command Code proxy section', () => {
  const defs = fs.readFileSync(path.join(root, 'src/renderer/js/settings-definitions.js'), 'utf8');
  assert.match(defs, /'Command Code 双号代理'/);
  assert.match(defs, /'ccProxy\.enabled'/);
  assert.match(defs, /'ccProxy\.pythonPath'/);
  assert.match(defs, /'ccProxy\.scriptPath'/);
  assert.match(defs, /'ccProxy\.key1'/);
  assert.match(defs, /'ccProxy\.key2'/);
});

test('settings window renders text inputs for proxy paths', () => {
  const win = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  assert.match(win, /case 'text':/);
});

test('settings security strips proxy keys and marks saved state', () => {
  const security = fs.readFileSync(path.join(root, 'src/main/core/settings-security.js'), 'utf8');
  assert.match(security, /\['ccProxy', 'key1'\]/);
  assert.match(security, /\['ccProxy', 'key2'\]/);
  assert.match(security, /clone\.ccProxy\.key1Set/);
  assert.match(security, /clone\.ccProxy\.key2Set/);
});
